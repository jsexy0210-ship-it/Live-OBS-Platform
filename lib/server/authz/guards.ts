import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { resolveAdminSession, resolveSellerSession, type AdminSessionContext } from "../auth/session";
import type { TenantContext } from "../tenant/context";
import { forbidden, notFound, unauthenticated } from "./errors";
import { adminCan, type AdminPermission } from "./permissions";

// 마스터 API 가드. 판매자·구매자 세션 토큰은 AdminSession 테이블에 없으므로 여기서 항상 401이다.
export async function requireAdmin(
  db: PrismaClient,
  token: string | undefined,
  permission: AdminPermission,
  now = new Date(),
): Promise<AdminSessionContext> {
  const ctx = await resolveAdminSession(db, token, now);
  if (!ctx) throw unauthenticated();
  if (!adminCan(ctx.admin.role, permission)) throw forbidden();
  return ctx;
}

// 판매자 API 가드. sellerId는 세션에서만 얻는다. 세부 권한은 requireSellerPermission으로 확인한다.
export async function requireSeller(db: PrismaClient, token: string | undefined, now = new Date()): Promise<TenantContext> {
  const ctx = await resolveSellerSession(db, token, now);
  if (!ctx) throw unauthenticated();
  return {
    sellerId: ctx.seller.id,
    actorType: "SELLER_USER",
    actorId: ctx.user.id,
    isOwner: ctx.user.isOwner,
    permissions: ctx.user.permissions,
    readOnly: false,
  };
}

// 마스터의 판매자 화면 대리 조회: 읽기 전용 컨텍스트, 사유 필수, 진입마다 감사 로그.
export async function impersonateSeller(
  db: PrismaClient,
  admin: AdminSessionContext,
  sellerId: string,
  reason: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<TenantContext> {
  if (!adminCan(admin.admin.role, "seller.impersonate")) throw forbidden();
  if (!reason.trim()) throw forbidden();
  const seller = await db.seller.findUnique({ where: { id: sellerId }, select: { id: true } });
  if (!seller) throw notFound();
  await writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    sellerId,
    action: "admin.impersonate.view",
    targetType: "Seller",
    targetId: sellerId,
    reason: reason.trim(),
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { sellerId, actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, isOwner: false, permissions: [], readOnly: true };
}
