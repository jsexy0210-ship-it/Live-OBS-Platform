import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { generateToken, hashToken } from "../auth/token";
import { sellerHasFeature } from "../billing/features";
import { sellerAccessFor } from "../billing/subscription";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 마지막 접속 시각은 이 간격이 지났을 때만 갱신하고, 운영 현황은 이 창 안에 접속했으면 「접속 중」으로 본다
export const OVERLAY_SEEN_WRITE_MS = 60_000;
export const OVERLAY_ONLINE_MS = 2 * 60_000;

// 오버레이 URL 토큰 발급·재발급. 새로 발급하면 이전 토큰은 바로 폐기된다. 원문 토큰은 이때 한 번만 돌려준다.
export async function issueOverlayToken(db: PrismaClient, ctx: TenantContext, now = new Date()): Promise<string> {
  requireSellerPermission(ctx, "OVERLAY_EDIT");
  const token = generateToken();
  await db.$transaction(async (tx) => {
    const revoked = await tx.overlayToken.updateMany({ where: { sellerId: ctx.sellerId, revokedAt: null }, data: { revokedAt: now } });
    const created = await tx.overlayToken.create({ data: { sellerId: ctx.sellerId, tokenHash: hashToken(token), createdAt: now } });
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
