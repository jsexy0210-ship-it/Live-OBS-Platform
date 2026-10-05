import type { Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { DEFAULT_PLAN_CODE, dbNow } from "../billing/subscription";

type Db = PrismaClient | Prisma.TransactionClient;
type Meta = { ip?: string | null; userAgent?: string | null };

// 승인 대기(PENDING) 쇼핑몰을 운영 중으로 바꾼다. 승인 시각과 체험하기 종료는 DB 시계로 정한다.
// 체험 일수는 판매자 플랜의 trialDays(오버레이 전용 7일, 통합 없음 = trialEndsAt null, ONQ 1-C·ARCHITECTURE 4.8.0)이고,
// 판매자 플랜이 없으면 신규 가입 기본 플랜(DEFAULT_PLAN_CODE)을 정해 남긴다. 「확인 필요」 사유는 비운다.
// 승인 대기가 아니면 null(동시에 두 번 불러도 한 번만 승인).
// adminId가 null이면 가입 자동 승인이다.
export async function activateSeller(db: Db, sellerId: string, adminId: string | null) {
  const rows = await db.$queryRaw<{ approvedAt: Date; trialEndsAt: Date | null }[]>`
    UPDATE "Seller" s
       SET "status" = 'ACTIVE', "approvedAt" = now(), "approvedByAdminId" = ${adminId}::uuid, "planId" = p."id",
           "trialEndsAt" = CASE WHEN p."trialDays" > 0 THEN now() + make_interval(days => p."trialDays") ELSE NULL END,
           "reviewReasons" = ARRAY[]::TEXT[]
      FROM "SubscriptionPlan" p
     WHERE s."id" = ${sellerId}::uuid AND s."status" = 'PENDING'
       AND p."id" = COALESCE(s."planId", (SELECT "id" FROM "SubscriptionPlan" WHERE "code" = ${DEFAULT_PLAN_CODE}))
     RETURNING s."approvedAt", s."trialEndsAt"`;
  return rows[0] ?? null;
}

// 판매자 가입 승인(마스터). 「확인 필요」에 올라온 쇼핑몰을 대표님이 직접 승인한다.
export async function approveSeller(db: PrismaClient, admin: AdminSessionContext, sellerId: string, meta: Meta = {}) {
  if (!adminCan(admin.admin.role, "seller.moderate")) throw forbidden();
  // 승인하면 걸린 항목이 지워지므로 되돌리기(applications.ts undoApproval)를 위해 승인 전 값을 로그 추적에 남긴다
  const before = await db.seller.findUnique({ where: { id: sellerId }, select: { reviewReasons: true } });
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
    before: { status: "PENDING", reviewReasons: before?.reviewReasons ?? [] },
    after: { status: "ACTIVE", trialEndsAt: row.trialEndsAt },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  // 보완 요청 중이던 신청이면 보완 요청을 푼다(기한 자동 반려 대상에서 빠진다)
  await db.sellerApplicationReview.updateMany({ where: { sellerId, supplementRequestedAt: { not: null }, supplementResolvedAt: null }, data: { supplementResolvedAt: row.approvedAt } });
  // undoableUntil: 이 시각까지 승인을 되돌릴 수 있다(10초)
  return { ok: true as const, approvedAt: row.approvedAt, trialEndsAt: row.trialEndsAt, undoableUntil: new Date(row.approvedAt.getTime() + 10_000) };
}

// 가입 반려(마스터). 승인 대기 쇼핑몰만, 사유 필수. 반려되면 같은 대표자가 다시 신청할 수 있다(1인 1쇼핑몰 규칙에서 제외).
export async function rejectSeller(db: PrismaClient, admin: AdminSessionContext, sellerId: string, reason: string, meta: Meta = {}) {
  if (!adminCan(admin.admin.role, "seller.moderate")) throw forbidden();
  const why = reason.trim().slice(0, 200);
  if (!why) return { ok: false as const, reason: "reason_required" as const };
  // 반려 사유·시각은 전용 컬럼에 둔다(정지 사유와 섞지 않음, MASTER 결정)
  const moved = await db.seller.updateMany({
    where: { id: sellerId, status: "PENDING" },
    data: { status: "REJECTED", rejectedReason: why, rejectedAt: await dbNow(db) },
  });
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
  await db.sellerApplicationReview.updateMany({ where: { sellerId, supplementRequestedAt: { not: null }, supplementResolvedAt: null }, data: { supplementResolvedAt: await dbNow(db) } });
  return { ok: true as const };
}

// 마스터 관리자 「확인 필요」 목록: 자동 승인되지 않은 승인 대기 쇼핑몰과 걸린 항목.
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
