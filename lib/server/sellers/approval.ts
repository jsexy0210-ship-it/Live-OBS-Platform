import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";

export const TRIAL_DAYS = 3;

// 판매자 가입 승인(마스터). 승인 시각과 체험하기 종료(승인 + 3일)는 DB 시계로 정한다(대표님 결정 2026-10-02).
// 승인 대기(PENDING)인 쇼핑몰만 승인할 수 있고, 동시에 두 번 눌러도 한 번만 승인된다.
export async function approveSeller(
  db: PrismaClient,
  admin: AdminSessionContext,
  sellerId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
) {
  if (!adminCan(admin.admin.role, "seller.moderate")) throw forbidden();
  const rows = await db.$queryRaw<{ approvedAt: Date; trialEndsAt: Date }[]>`
    UPDATE "Seller"
       SET "status" = 'ACTIVE', "approvedAt" = now(), "approvedByAdminId" = ${admin.admin.id}::uuid,
           "trialEndsAt" = now() + make_interval(days => ${TRIAL_DAYS}::int)
     WHERE "id" = ${sellerId}::uuid AND "status" = 'PENDING'
     RETURNING "approvedAt", "trialEndsAt"`;
  if (rows.length === 0) {
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
    after: { status: "ACTIVE", trialEndsAt: rows[0].trialEndsAt },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { ok: true as const, approvedAt: rows[0].approvedAt, trialEndsAt: rows[0].trialEndsAt };
}
