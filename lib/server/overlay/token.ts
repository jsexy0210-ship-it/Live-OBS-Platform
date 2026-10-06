import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { generateToken, hashToken } from "../auth/token";
import { sellerHasFeature } from "../billing/features";
import { sellerAccessFor } from "../billing/subscription";
import { liveBroadcastState } from "../broadcast/stale";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 마지막 접속 시각은 이 간격이 지났을 때만 갱신하고, 운영 현황은 이 창 안에 접속했으면 「접속 중」으로 본다
export const OVERLAY_SEEN_WRITE_MS = 60_000;
export const OVERLAY_ONLINE_MS = 2 * 60_000;

// 오버레이 URL 토큰 발급·재발급. 새로 발급하면 이전 토큰은 바로 폐기된다. 원문 토큰은 이때 한 번만 돌려준다.
export async function issueOverlayToken(db: PrismaClient, ctx: TenantContext, now = new Date()): Promise<string> {
  requireSellerPermission(ctx, "OVERLAY_EDIT");
  const token = generateToken();
  // 발급한 사람(재발급 이력용 스냅숏): 「쇼핑몰 이름 · 직원 이름」
  const [shop, user] = await Promise.all([
    db.seller.findUnique({ where: { id: ctx.sellerId }, select: { shopName: true } }),
    ctx.actorType === "SELLER_USER" && ctx.actorId ? db.sellerUser.findFirst({ where: { id: ctx.actorId, sellerId: ctx.sellerId }, select: { name: true } }) : null,
  ]);
  const issuedByName = [shop?.shopName, user?.name].filter(Boolean).join(" · ") || null;
  await db.$transaction(async (tx) => {
    const revoked = await tx.overlayToken.updateMany({ where: { sellerId: ctx.sellerId, revokedAt: null }, data: { revokedAt: now } });
    const created = await tx.overlayToken.create({ data: { sellerId: ctx.sellerId, tokenHash: hashToken(token), createdAt: now, issuedByName } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "overlay.token.issue",
      targetType: "OverlayToken",
      targetId: created.id,
      after: { revokedPrevious: revoked.count },
    });
  });
  return token;
}

// 방송 중에는 재발급할 수 없다(SA-052). 처음 발급(살아 있는 주소가 없을 때)은 방송 중에도 된다.
// 「방송 중」은 LIVE 방송이 있고 방송 화면 접속 신호가 최근 5분 안에 있을 때만이다(broadcast/stale.ts). 신호 없이 LIVE만 남은 방송이 재발급을 영구히 막지 않게 한다.
export async function reissueBlockedByLive(db: PrismaClient, sellerId: string): Promise<boolean> {
  const current = await db.overlayToken.findFirst({ where: { sellerId, revokedAt: null }, select: { id: true } });
  return !!current && (await liveBroadcastState(db, sellerId)).active;
}

// 오버레이 토큰으로 판매자를 찾는다. 폐기된 토큰, 운영 중이 아닌 판매자, 구독이 끝나 잠긴 판매자,
// 오버레이 기능 권한이 없는 판매자(통합 첫 결제 확정 전, ARCHITECTURE 4.8.0)는 null
// (state·version·stream 모두 404, 열려 있는 SSE는 다음 핑 재확인 때 닫힘. MASTER 결정 2026-10-03).
export async function resolveOverlayToken(db: PrismaClient, token: string | undefined, now?: Date): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const row = await db.overlayToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, sellerId: true, revokedAt: true, seller: { select: { status: true } } },
  });
  if (!row || row.revokedAt || row.seller.status !== "ACTIVE") return null;
  // 이용 제한은 DB 시계로 판단한다
  if ((await sellerAccessFor(db, row.sellerId, now)) === "expired") return null;
  if (!(await sellerHasFeature(db, row.sellerId, "OVERLAY", now))) return null;
  // 마지막 접속 시각(운영 현황 MA-041·042). 오버레이는 15초마다 확인하므로 1분이 지났을 때만 쓴다.
  await db.$executeRaw`UPDATE "OverlayToken" SET "lastSeenAt" = clock_timestamp()
    WHERE "id" = ${row.id}::uuid AND ("lastSeenAt" IS NULL OR "lastSeenAt" < clock_timestamp() - ${`${OVERLAY_SEEN_WRITE_MS} milliseconds`}::interval)`;
  return row.sellerId;
}
