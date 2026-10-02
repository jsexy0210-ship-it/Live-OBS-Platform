import { Prisma, type PrismaClient, type SellerStaffPermission } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { forbidden, notFound } from "../authz/errors";
import { isStaffPermission } from "../authz/permissions";
import { MIN_PASSWORD_LENGTH } from "../auth/passwordReset";
import { hashPassword } from "../auth/password";
import { normalizeEmail } from "../auth/login";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 직원 관리(대표자 전용, STAFF_MANAGE). 대표자가 직원 계정을 직접 만들고 권한 항목을 켜고 끈다.
// 같은 쇼핑몰 직원만 다루고(다른 쇼핑몰은 없음으로 처리), 대표자 계정은 대상이 아니다. 생성·권한 변경·비활성화는 감사 로그.

type Meta = { ip?: string | null; userAgent?: string | null; now?: Date };

const STAFF_FIELDS = { id: true, email: true, name: true, permissions: true, status: true, lastLoginAt: true, createdAt: true } as const;

export type StaffFailure = "invalid_permissions" | "weak_password" | "email_taken" | "bad_request";
export type StaffResult<T> = { ok: true; value: T } | { ok: false; reason: StaffFailure };

function cleanPermissions(input: unknown): SellerStaffPermission[] | null {
  if (!Array.isArray(input) || !input.every(isStaffPermission)) return null;
  return [...new Set(input)].sort();
}

export async function listStaff(db: PrismaClient, ctx: TenantContext) {
  requireSellerPermission(ctx, "STAFF_MANAGE");
  return db.sellerUser.findMany({
    where: { sellerId: ctx.sellerId, isOwner: false },
    orderBy: { createdAt: "asc" },
    select: STAFF_FIELDS,
  });
}

export async function createStaff(
  db: PrismaClient,
  ctx: TenantContext,
  input: { email: string; name: string; password: string; permissions: unknown },
  meta: Meta = {},
): Promise<StaffResult<{ id: string }>> {
  requireSellerPermission(ctx, "STAFF_MANAGE");
  const permissions = cleanPermissions(input.permissions);
  if (!permissions) return { ok: false, reason: "invalid_permissions" };
  if (input.password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "weak_password" };
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (!email.includes("@") || !name) return { ok: false, reason: "bad_request" };
  const passwordHash = await hashPassword(input.password);
  try {
    const staff = await db.$transaction(async (tx) => {
      const created = await tx.sellerUser.create({
        data: { sellerId: ctx.sellerId, email, name, passwordHash, isOwner: false, permissions, createdAt: meta.now },
        select: STAFF_FIELDS,
      });
      await writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: "seller.staff.create",
        targetType: "SellerUser",
        targetId: created.id,
        after: { email, name, permissions },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return created;
    });
    return { ok: true, value: { id: staff.id } };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false, reason: "email_taken" };
    throw e;
  }
}

async function loadStaff(db: PrismaClient | Prisma.TransactionClient, ctx: TenantContext, staffUserId: string) {
  const staff = await db.sellerUser.findFirst({ where: { id: staffUserId, sellerId: ctx.sellerId } });
  if (!staff) throw notFound();
  if (staff.isOwner) throw forbidden();
  return staff;
}

export async function updateStaffPermissions(
  db: PrismaClient,
  ctx: TenantContext,
  input: { staffUserId: string; permissions: unknown },
  meta: Meta = {},
): Promise<StaffResult<{ permissions: SellerStaffPermission[] }>> {
  requireSellerPermission(ctx, "STAFF_MANAGE");
  const permissions = cleanPermissions(input.permissions);
  if (!permissions) return { ok: false, reason: "invalid_permissions" };
  await db.$transaction(async (tx) => {
    const staff = await loadStaff(tx, ctx, input.staffUserId);
    await tx.sellerUser.update({ where: { id: staff.id }, data: { permissions } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.staff.permissions",
      targetType: "SellerUser",
      targetId: staff.id,
      before: { permissions: staff.permissions },
      after: { permissions },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true, value: { permissions } };
}

// 비활성화: 로그인할 수 없게 하고 기존 세션을 모두 끊는다.
export async function disableStaff(db: PrismaClient, ctx: TenantContext, input: { staffUserId: string }, meta: Meta = {}) {
  requireSellerPermission(ctx, "STAFF_MANAGE");
  const now = meta.now ?? new Date();
  await db.$transaction(async (tx) => {
    const staff = await loadStaff(tx, ctx, input.staffUserId);
    await tx.sellerUser.update({ where: { id: staff.id }, data: { status: "DISABLED" } });
    const revoked = await tx.sellerSession.updateMany({ where: { sellerUserId: staff.id, revokedAt: null }, data: { revokedAt: now } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.staff.disable",
      targetType: "SellerUser",
      targetId: staff.id,
      before: { status: staff.status },
      after: { status: "DISABLED", revokedSessions: revoked.count },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true as const };
}
