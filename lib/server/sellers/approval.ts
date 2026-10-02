import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";

export const TRIAL_DAYS = 3;

type Db = PrismaClient | Prisma.TransactionClient;
type Meta = { ip?: string | null; userAgent?: string | null };

// 승인 대기(PENDING) 쇼핑몰을 운영 중으로 바꾼다. 승인 시각과 체험하기 종료(승인 + 3일)는 DB 시계로 정한다
// (대표님 결정 2026-10-02). 「확인 필요」 사유는 비운다. 승인 대기가 아니면 null(동시에 두 번 불러도 한 번만 승인).
// adminId가 null이면 가입 자동 승인이다.
export async function activateSeller(db: Db, sellerId: string, adminId: string | null) {
  const rows = await db.$queryRaw<{ approvedAt: Date; trialEndsAt: Date }[]>`
    UPDATE "Seller"
       SET "status" = 'ACTIVE', "approvedAt" = now(), "approvedByAdminId" = ${adminId}::uuid,
           "trialEndsAt" = now() + make_interval(days => ${TRIAL_DAYS}::int), "reviewReasons" = ARRAY[]::TEXT[]
     WHERE "id" = ${sellerId}::uuid AND "status" = 'PENDING'
     RETURNING "approvedAt", "trialEndsAt"`;
  return rows[0] ?? null;
}

// 판매자 가입 승인(마스터). 「확인 필요」에 올라온 쇼핑몰을 대표님이 직접 승인한다.
export async function approveSeller(db: PrismaClient, admin: AdminSessionContext, sellerId: string, meta: Meta = {}) {
  if (!adminCan(admin.admin.role, "seller.moderate")) throw forbidden();
  const row = await activateSeller(db, sellerId, admin.admin.id);
  if (!row) {
    const exists = await db.seller.findUnique({ where: { id: sellerId }, select: { id: true } });
    return { ok: false as const, reason: exists ? ("not_pending" as const) : ("not_found" as const) };
  }
  await writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    sellerId,
    action: "admin.seller.approve",
    targetType: "Seller",
    targetId: sellerId,
    after: { status: "ACTIVE", trialEndsAt: row.trialEndsAt },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const, approvedAt: row.approvedAt, trialEndsAt: row.trialEndsAt };
}

// 가입 반려(마스터). 승인 대기 쇼핑몰만, 사유 필수. 반려되면 같은 대표자가 다시 신청할 수 있다(1인 1쇼핑몰 규칙에서 제외).
export async function rejectSeller(db: PrismaClient, admin: AdminSessionContext, sellerId: string, reason: string, meta: Meta = {}) {
  if (!adminCan(admin.admin.role, "seller.moderate")) throw forbidden();
  const why = reason.trim().slice(0, 200);
  if (!why) return { ok: false as const, reason: "reason_required" as const };
  const moved = await db.seller.updateMany({ where: { id: sellerId, status: "PENDING" }, data: { status: "REJECTED", suspendedReason: why } });
  if (moved.count !== 1) {
    const exists = await db.seller.findUnique({ where: { id: sellerId }, select: { id: true } });
    return { ok: false as const, reason: exists ? ("not_pending" as const) : ("not_found" as const) };
  }
  await writeAudit(db, {
    actorType: "PLATFORM_ADMIN",
    actorId: admin.admin.id,
    sellerId,
    action: "admin.seller.reject",
    targetType: "Seller",
    targetId: sellerId,
    reason: why,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const };
}

// 마스터 콘솔 「확인 필요」 목록: 자동 승인되지 않은 승인 대기 쇼핑몰과 걸린 항목.
export async function listSellersToReview(db: PrismaClient, admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  const sellers = await db.seller.findMany({
    where: { status: "PENDING" },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { id: true, slug: true, shopName: true, businessInfo: true, reviewReasons: true, createdAt: true },
  });
  return sellers;
}
