import { Prisma, type PlatformAdminRole, type PlatformAdminStatus, type PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { writeAudit } from "../audit/log";
import { forbidden } from "../authz/errors";
import { ADMIN_PERMISSIONS, adminCan, type AdminPermission } from "../authz/permissions";
import { hashPassword } from "../auth/password";
import { MIN_PASSWORD_LENGTH } from "../auth/passwordReset";
import { dbNow } from "../billing/subscription";

// 마스터 관리자 계정(MA-061·062)과 역할별 권한 표(MA-063). 모두 admin.manage(최고관리자)만.
// 역할·상태는 요청마다 DB에서 다시 읽으므로(auth/session.ts) 바꾸면 바로 적용된다. 정지하면 그 계정의 세션도 끝낸다.
// 최고관리자가 한 명도 남지 않게 되는 변경(마지막 최고관리자의 역할 변경·정지)은 막는다.
const ROLES: readonly PlatformAdminRole[] = ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"];
const STATUSES: readonly PlatformAdminStatus[] = ["ACTIVE", "SUSPENDED"];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
type Meta = { ip?: string | null; userAgent?: string | null };

function requireManage(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "admin.manage")) throw forbidden();
}

const VIEW = { id: true, email: true, name: true, role: true, status: true, lastLoginAt: true, createdAt: true } as const satisfies Prisma.PlatformAdminSelect;

export async function listAdmins(db: PrismaClient, admin: AdminSessionContext) {
  requireManage(admin);
  return db.platformAdmin.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: VIEW });
}

// 역할별 권한 표: 권한마다 가진 역할, 역할마다 가진 권한(lib/server/authz/permissions.ts가 정본)
export function permissionTable(admin: AdminSessionContext) {
  requireManage(admin);
  const permissions = Object.keys(ADMIN_PERMISSIONS) as AdminPermission[];
  return {
    roles: ROLES,
    permissions: permissions.map((p) => ({ permission: p, roles: [...ADMIN_PERMISSIONS[p]] })),
    byRole: Object.fromEntries(ROLES.map((r) => [r, permissions.filter((p) => adminCan(r, p))])) as Record<PlatformAdminRole, AdminPermission[]>,
  };
}

export type CreateAdminFailure = "invalid_input" | "weak_password" | "email_taken";

// 계정 추가. 처음 비밀번호는 최고관리자가 정해 따로 전한다(응답·로그 추적에 넣지 않음).
export async function createAdmin(
  db: PrismaClient,
  admin: AdminSessionContext,
  input: { email?: unknown; name?: unknown; role?: unknown; password?: unknown },
  meta: Meta = {},
) {
  requireManage(admin);
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!EMAIL_RE.test(email) || !name || name.length > 50 || !ROLES.includes(input.role as PlatformAdminRole)) return { ok: false as const, reason: "invalid_input" as const };
  if (typeof input.password !== "string" || input.password.length < MIN_PASSWORD_LENGTH || input.password.length > 200) return { ok: false as const, reason: "weak_password" as const };
  const passwordHash = await hashPassword(input.password);
  try {
    return await db.$transaction(async (tx) => {
      const created = await tx.platformAdmin.create({ data: { email, name, role: input.role as PlatformAdminRole, passwordHash }, select: VIEW });
      await writeAudit(tx, {
        actorType: "PLATFORM_ADMIN",
        actorId: admin.admin.id,
        action: "admin.account.create",
        targetType: "PlatformAdmin",
        targetId: created.id,
        after: { email: created.email, name: created.name, role: created.role },
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
      return { ok: true as const, admin: created };
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { ok: false as const, reason: "email_taken" as const };
    throw e;
  }
}

export type UpdateAdminFailure = "invalid_input" | "not_found" | "last_super_admin";

// 이름·역할·상태 바꾸기(빼고 보내면 그대로). 정지하면 세션을 끝낸다. 최고관리자 행들을 잠그고 남는 수를 세어 마지막 한 명을 지킨다.
export async function updateAdmin(
  db: PrismaClient,
  admin: AdminSessionContext,
  adminId: string,
  input: { name?: unknown; role?: unknown; status?: unknown },
  meta: Meta = {},
) {
  requireManage(admin);
  const name = input.name === undefined ? undefined : typeof input.name === "string" ? input.name.trim() : null;
  if (name !== undefined && (!name || name.length > 50)) return { ok: false as const, reason: "invalid_input" as const };
  if (input.role !== undefined && !ROLES.includes(input.role as PlatformAdminRole)) return { ok: false as const, reason: "invalid_input" as const };
  if (input.status !== undefined && !STATUSES.includes(input.status as PlatformAdminStatus)) return { ok: false as const, reason: "invalid_input" as const };
  const role = input.role as PlatformAdminRole | undefined;
  const status = input.status as PlatformAdminStatus | undefined;
  if (name === undefined && role === undefined && status === undefined) return { ok: false as const, reason: "invalid_input" as const };
  return db.$transaction(async (tx) => {
    // 최고관리자 수를 세기 전에 그 행들(과 대상)을 같은 순서로 잠근다(동시에 두 명을 내려도 마지막 한 명은 남는다)
    await tx.$queryRaw`SELECT "id" FROM "PlatformAdmin" WHERE "role" = 'SUPER_ADMIN' OR "id" = ${adminId}::uuid ORDER BY "id" FOR UPDATE`;
    const before = await tx.platformAdmin.findUnique({ where: { id: adminId }, select: VIEW });
    if (!before) return { ok: false as const, reason: "not_found" as const };
    const losesSuper = before.role === "SUPER_ADMIN" && before.status === "ACTIVE" && ((role !== undefined && role !== "SUPER_ADMIN") || status === "SUSPENDED");
    if (losesSuper) {
      const supers = await tx.platformAdmin.count({ where: { role: "SUPER_ADMIN", status: "ACTIVE" } });
      if (supers <= 1) return { ok: false as const, reason: "last_super_admin" as const };
    }
    const after = await tx.platformAdmin.update({ where: { id: adminId }, data: { ...(name !== undefined ? { name } : {}), ...(role ? { role } : {}), ...(status ? { status } : {}) }, select: VIEW });
    let revokedSessions = 0;
    if (status === "SUSPENDED" && before.status !== "SUSPENDED") {
      const now = await dbNow(tx);
      revokedSessions = (await tx.adminSession.updateMany({ where: { adminId, revokedAt: null }, data: { revokedAt: now } })).count;
    }
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "admin.account.update",
      targetType: "PlatformAdmin",
      targetId: adminId,
      before: { name: before.name, role: before.role, status: before.status },
      after: { name: after.name, role: after.role, status: after.status, revokedSessions },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, admin: after };
  });
}
