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

// 직원 이름 최대 글자 수. 만들기·고치기·본인확인 연결 비교가 모두 이 값을 쓴다(sellers/staffIdentity.ts).
export const STAFF_NAME_MAX = 50;

const STAFF_FIELDS = { id: true, email: true, name: true, phone: true, identityLinkedAt: true, permissions: true, status: true, lastLoginAt: true, createdAt: true } as const;

export type StaffFailure = "invalid_permissions" | "weak_password" | "email_taken" | "bad_request" | "invalid_phone";

// 직원 휴대폰 번호: 숫자만 남겨 01로 시작하는 10~11자리. 빈 값·null은 「등록 안 함」(null), 형식이 틀리면 false.
export function normalizeStaffPhone(raw: unknown): string | null | false {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return false;
  const digits = raw.normalize("NFKC").replace(/[ -]/g, "");
  return /^01\d{8,9}$/.test(digits) ? digits : false;
}

// 감사 로그에는 번호 원문을 남기지 않는다(끝 4자리만)
const maskPhone = (p: string | null) => (p ? `***${p.slice(-4)}` : null);
export type StaffResult<T> = { ok: true; value: T } | { ok: false; reason: StaffFailure };

function cleanPermissions(input: unknown): SellerStaffPermission[] | null {
  if (!Array.isArray(input) || !input.every(isStaffPermission)) return null;
  return [...new Set(input)].sort();
}

export async function listStaff(db: PrismaClient, ctx: TenantContext) {
  requireSellerPermission(ctx, "STAFF_MANAGE");
  const rows = await db.sellerUser.findMany({
    where: { sellerId: ctx.sellerId, isOwner: false },
    orderBy: { createdAt: "asc" },
    select: STAFF_FIELDS,
  });
  // 연결 CI 해시는 내보내지 않고 연결 여부만 준다
  return rows.map(({ identityLinkedAt, ...r }) => ({ ...r, identityLinked: identityLinkedAt !== null }));
}

export async function createStaff(
  db: PrismaClient,
  ctx: TenantContext,
  // phone: 직원 휴대폰(선택). 직원 셀프 아이디·비밀번호 찾기를 쓰려면 등록하고 직원이 본인확인으로 연결해야 한다.
  input: { email: string; name: string; password: string; permissions: unknown; phone?: unknown },
  meta: Meta = {},
): Promise<StaffResult<{ id: string }>> {
  requireSellerPermission(ctx, "STAFF_MANAGE");
  const permissions = cleanPermissions(input.permissions);
  if (!permissions) return { ok: false, reason: "invalid_permissions" };
  if (input.password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: "weak_password" };
  const email = normalizeEmail(input.email);
  const name = input.name.trim();
  if (!email.includes("@") || !name || name.length > STAFF_NAME_MAX) return { ok: false, reason: "bad_request" };
  const phone = normalizeStaffPhone(input.phone);
  if (phone === false) return { ok: false, reason: "invalid_phone" };
  const passwordHash = await hashPassword(input.password);
  try {
    const staff = await db.$transaction(async (tx) => {
      const created = await tx.sellerUser.create({
        data: { sellerId: ctx.sellerId, email, name, phone, passwordHash, isOwner: false, permissions, createdAt: meta.now },
        select: STAFF_FIELDS,
      });
      await writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: "seller.staff.create",
        targetType: "SellerUser",
        targetId: created.id,
        after: { email, name, phone: maskPhone(phone), permissions },
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

// 직원 이름·휴대폰 고치기(대표자 전용). 기존 직원(휴대폰 없음)도 나중에 채울 수 있다. 보낸 칸만 바꾼다(phone: null·""이면 지움).
// 휴대폰 번호가 바뀌면 연결된 CI를 지워 직원이 다시 본인확인으로 연결해야 한다(번호가 다른 사람에게 넘어가도 복구되지 않게).
// 로그인·권한은 그대로다(연결은 셀프 찾기에만 쓴다, MASTER 2026-10-04).
export async function updateStaffProfile(
  db: PrismaClient,
  ctx: TenantContext,
  input: { staffUserId: string; name?: unknown; phone?: unknown },
  meta: Meta = {},
): Promise<StaffResult<{ name: string; phone: string | null; identityLinked: boolean }>> {
  requireSellerPermission(ctx, "STAFF_MANAGE");
  if (input.name !== undefined && (typeof input.name !== "string" || !input.name.trim() || input.name.trim().length > STAFF_NAME_MAX)) return { ok: false, reason: "bad_request" };
  const phone = input.phone === undefined ? undefined : normalizeStaffPhone(input.phone);
  if (phone === false) return { ok: false, reason: "invalid_phone" };
  const value = await db.$transaction(async (tx) => {
    const staff = await loadStaff(tx, ctx, input.staffUserId);
    const name = typeof input.name === "string" ? input.name.trim() : staff.name;
    const nextPhone = phone === undefined ? staff.phone : phone;
    const phoneChanged = nextPhone !== staff.phone;
    const unlink = phoneChanged && staff.identityCiHash !== null;
    const updated = await tx.sellerUser.update({
      where: { id: staff.id },
      data: { name, phone: nextPhone, ...(phoneChanged ? { identityCiHash: null, identityLinkedAt: null } : {}) },
      select: { name: true, phone: true, identityLinkedAt: true },
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.staff.profile",
      targetType: "SellerUser",
      targetId: staff.id,
      before: { name: staff.name, phone: maskPhone(staff.phone), identityLinked: staff.identityCiHash !== null },
      after: { name, phone: maskPhone(nextPhone), identityLinked: updated.identityLinkedAt !== null, identityUnlinked: unlink },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { name: updated.name, phone: updated.phone, identityLinked: updated.identityLinkedAt !== null };
  });
  return { ok: true, value };
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
