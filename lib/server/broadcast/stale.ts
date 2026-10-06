import type { Prisma, PrismaClient } from "@prisma/client";
import { dbNow } from "../billing/subscription";
import { endBroadcast } from "../queue/service";
import type { TenantContext } from "../tenant/context";

// 방송 상태가 LIVE로 남은 채 끝나지 않는 경우(종료 누르기 전에 PC가 꺼짐·개봉 중이 남음 등) 때문에 재발급이 영구히 막히지 않게 하는 기준.
// - 「방송 중으로 본다」(active): LIVE 방송이 있고, 시작한 지 BROADCAST_STALE_MS 안이거나 방송 화면 주소에 BROADCAST_STALE_MS 안에 접속 신호가 있었다.
//   방송 화면은 15초마다 확인하고 접속 시각은 1분에 한 번 갱신되므로, 5분 동안 신호가 없으면 방송 화면이 끊긴 것으로 본다. 방송 상태(LIVE) 자체는 바꾸지 않는다.
// - 오래 버려진 방송: LIVE인데 BROADCAST_ABANDON_MS 동안 신호가 없고 개봉 중 항목이 없으면 정기 실행이 끝낸다(감사 broadcast.auto_end, 남은 대기는 다음 방송으로 이월).
//   개봉 중이 남은 방송은 자동으로 끝내지 않는다(파트너스가 완료·취소하거나 마스터 관리자가 강제 종료).
export const BROADCAST_STALE_MS = 5 * 60_000;
export const BROADCAST_ABANDON_MS = 12 * 3_600_000;
type Db = PrismaClient | Prisma.TransactionClient;

export async function liveBroadcastState(db: Db, sellerId: string, now?: Date) {
  const at = now ?? (await dbNow(db));
  const [live, seen] = await Promise.all([
    db.broadcastSession.findFirst({ where: { sellerId, status: "LIVE" }, select: { id: true, startedAt: true } }),
    db.overlayToken.findFirst({ where: { sellerId, revokedAt: null }, select: { lastSeenAt: true } }),
  ]);
  if (!live) return { live: false as const, active: false, lastSignalAt: seen?.lastSeenAt ?? null };
  const lastSignalAt = seen?.lastSeenAt && seen.lastSeenAt > live.startedAt ? seen.lastSeenAt : live.startedAt;
  return { live: true as const, active: at.getTime() - lastSignalAt.getTime() < BROADCAST_STALE_MS, lastSignalAt, sessionId: live.id };
}

// 정기 실행: 오래 버려진 LIVE 방송을 끝낸다. 끝낸 방송 수를 돌려준다.
export async function closeAbandonedBroadcasts(db: PrismaClient, now?: Date): Promise<number> {
  const at = now ?? (await dbNow(db));
  const cutoff = new Date(at.getTime() - BROADCAST_ABANDON_MS);
  const rows = await db.$queryRaw<{ sellerId: string }[]>`
    SELECT b."sellerId" FROM "BroadcastSession" b
    WHERE b."status" = 'LIVE' AND b."startedAt" <= ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "OverlayToken" t WHERE t."sellerId" = b."sellerId" AND t."revokedAt" IS NULL AND t."lastSeenAt" > ${cutoff})
      AND NOT EXISTS (SELECT 1 FROM "QueueItem" q WHERE q."sellerId" = b."sellerId" AND q."status" = 'OPENING')
    LIMIT 100`;
  let ended = 0;
  for (const r of rows) {
    const ctx: TenantContext = { sellerId: r.sellerId, actorType: "SYSTEM", actorId: "", isOwner: true, permissions: [], readOnly: false };
    const res = await endBroadcast(db, ctx, { now: at, audit: "broadcast.auto_end" });
    if (res.ok) ended++;
  }
  return ended;
}
