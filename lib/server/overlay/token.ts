import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { generateToken, hashToken } from "../auth/token";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 오버레이 URL 토큰 발급·재발급. 새로 발급하면 이전 토큰은 바로 폐기된다. 원문 토큰은 이때 한 번만 돌려준다.
export async function issueOverlayToken(db: PrismaClient, ctx: TenantContext, now = new Date()): Promise<string> {
  requireSellerPermission(ctx, "overlay.manage");
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

// 오버레이 토큰으로 판매자를 찾는다. 폐기된 토큰이나 운영 중이 아닌 판매자는 null.
export async function resolveOverlayToken(db: PrismaClient, token: string | undefined): Promise<string | null> {
  if (!token || token.length > 100) return null;
  const row = await db.overlayToken.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { sellerId: true, revokedAt: true, seller: { select: { status: true } } },
  });
  if (!row || row.revokedAt || row.seller.status !== "ACTIVE") return null;
  return row.sellerId;
}
