import type { Prisma, PrismaClient } from "@prisma/client";

// 방송 화면·연결 로그(SA-055). 오버레이 실시간 채널(SSE) 연결·끊김·복구와 방송 시작·종료만 남긴다. 기록 실패는 오버레이·방송 동작을 막지 않는다.
// - 연결: LIVE 방송이 있으면 그 방송에, 없으면 방송 전 연결로(방송 시작 직전 30분 안이면 그 방송 로그에 보인다). 같은 방송에서 이미 연결 중이면(탭 여러 개·재접속) 새로 남기지 않는다.
// - 끊김: 마지막 연결이 모두 닫힌 뒤 DISCONNECT_GRACE_MS 동안 다시 안 붙으면 끊김으로 본다(브라우저 자동 재접속 깜빡임 제외). LIVE 방송 중에만.
// - 복구: 끊김 뒤 다시 연결되면, 끊겨 있던 초와 함께.
export const PRE_START_WINDOW_MS = 30 * 60_000;
export const DISCONNECT_GRACE_MS = 5_000;
export const EVENT_LIMIT = 200;
type Db = PrismaClient | Prisma.TransactionClient;

export async function recordOverlayConnect(db: PrismaClient, sellerId: string, now = new Date()): Promise<void> {
  try {
    const live = await db.broadcastSession.findFirst({ where: { sellerId, status: "LIVE" }, select: { id: true, startedAt: true } });
    if (live) {
      const last = await db.broadcastEvent.findFirst({ where: { broadcastSessionId: live.id }, orderBy: [{ at: "desc" }, { id: "desc" }] });
      if (last?.kind === "DISCONNECTED") {
        await db.broadcastEvent.create({ data: { sellerId, broadcastSessionId: live.id, kind: "RECOVERED", at: now, downSeconds: Math.max(0, Math.round((now.getTime() - last.at.getTime()) / 1000)) } });
        return;
      }
      // 처음 연결: 이 방송 로그나 방송 시작 직전 30분 안에 연결이 이미 있으면 남기지 않는다
      const seen = await db.broadcastEvent.findFirst({
        where: { sellerId, kind: "CONNECTED", OR: [{ broadcastSessionId: live.id }, { broadcastSessionId: null, at: { gte: new Date(live.startedAt.getTime() - PRE_START_WINDOW_MS) } }] },
      });
      if (!seen) await db.broadcastEvent.create({ data: { sellerId, broadcastSessionId: live.id, kind: "CONNECTED", at: now } });
      return;
    }
    const recent = await db.broadcastEvent.findFirst({ where: { sellerId, broadcastSessionId: null, at: { gte: new Date(now.getTime() - PRE_START_WINDOW_MS) } } });
    if (!recent) await db.broadcastEvent.create({ data: { sellerId, broadcastSessionId: null, kind: "CONNECTED", at: now } });
  } catch {
    // 로그 실패는 무시
  }
}

export async function recordOverlayDisconnect(db: PrismaClient, sellerId: string, at: Date): Promise<void> {
  try {
    const live = await db.broadcastSession.findFirst({ where: { sellerId, status: "LIVE" }, select: { id: true } });
    if (!live) return;
    const last = await db.broadcastEvent.findFirst({ where: { broadcastSessionId: live.id }, orderBy: [{ at: "desc" }, { id: "desc" }] });
    if (last?.kind === "DISCONNECTED") return;
    await db.broadcastEvent.create({ data: { sellerId, broadcastSessionId: live.id, kind: "DISCONNECTED", at } });
  } catch {
    // 로그 실패는 무시
  }
}

// 방송 시작·종료(방송 처리 트랜잭션 안에서 함께 남긴다)
export async function recordBroadcastBoundary(db: Db, sellerId: string, broadcastSessionId: string, kind: "LIVE_STARTED" | "ENDED", at: Date, waiting?: number): Promise<void> {
  await db.broadcastEvent.create({ data: { sellerId, broadcastSessionId, kind, at, ...(waiting === undefined ? {} : { waiting }) } });
}

export async function listBroadcastEvents(db: Db, sellerId: string, id: string, startedAt: Date) {
  const rows = await db.broadcastEvent.findMany({
    where: { sellerId, OR: [{ broadcastSessionId: id }, { broadcastSessionId: null, at: { gte: new Date(startedAt.getTime() - PRE_START_WINDOW_MS), lte: startedAt } }] },
    orderBy: [{ at: "asc" }, { id: "asc" }],
    take: EVENT_LIMIT,
  });
  const KIND = { CONNECTED: "connected", LIVE_STARTED: "live", DISCONNECTED: "disconnected", RECOVERED: "recovered", ENDED: "ended" } as const;
  return rows.map((e) => ({ at: e.at, kind: KIND[e.kind], downSeconds: e.downSeconds, waiting: e.waiting }));
}
