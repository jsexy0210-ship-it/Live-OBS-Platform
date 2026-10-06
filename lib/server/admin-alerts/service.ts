import type { AdminAlertSeverity, AdminAlertStatus, PlatformAdminRole, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";

// 마스터 관리자 알림 센터(MA-002) 저장형 알림. 화면 안 알림만 만든다(메일·문자·알림톡 등 외부 발송 없음, 유료 발송 금지).
// 다른 기능(문의·인프라 감시 등)은 createAdminAlert 한 곳으로만 알림을 만든다.
// - 알림마다 처리 화면으로 가는 linkPath(상대 경로, `/admin/…`)를 단다.
// - targetRoles에 든 역할만 그 알림을 보고, 담당·상태(미처리 OPEN·처리 중 IN_PROGRESS·해결됨 RESOLVED)는 모두 같은 값을 본다. 읽음은 관리자마다.
// - 변경(처리 중·해결됨·미처리로 되돌림)은 support.assign(최고관리자·운영·CS), 처리 중으로 바꾸면 담당이 없을 때 바꾼 사람이 담당이 된다.

export const PAGE_SIZE = 50;
export const TITLE_MAX = 120;
export const BODY_MAX = 500;
export const ALERT_ROLES: readonly PlatformAdminRole[] = ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"];
export const SEVERITIES: readonly AdminAlertSeverity[] = ["URGENT", "WARNING", "INFO"];
export const STATUSES: readonly AdminAlertStatus[] = ["OPEN", "IN_PROGRESS", "RESOLVED"];

export type CreateAdminAlertInput = {
  kind: string; // 유형 코드(예: INQUIRY_URGENT). 화면 필터에 쓰는 짧은 영문 대문자·밑줄
  severity: AdminAlertSeverity;
  title: string;
  body?: string | null;
  linkPath: string; // `/admin/…` 상대 경로
  sellerId?: string | null;
  targetRoles?: readonly PlatformAdminRole[]; // 기본: 전 역할
  dedupeKey?: string | null; // 같은 키의 알림이 이미 있으면 새로 만들지 않는다
  occurredAt?: Date;
};

const KIND = /^[A-Z][A-Z0-9_]{1,39}$/;
const LINK = /^\/admin(\/[A-Za-z0-9._~\-/]*)?(\?[A-Za-z0-9._~\-=&%]*)?$/;

// 알림 만들기(트랜잭션 안에서도 쓸 수 있다). 값이 틀리면 던진다(개발 실수). 같은 dedupeKey가 있으면 { created: false }.
export async function createAdminAlert(db: PrismaClient | Prisma.TransactionClient, input: CreateAdminAlertInput) {
  const title = input.title.trim().slice(0, TITLE_MAX);
  const body = input.body ? input.body.trim().slice(0, BODY_MAX) || null : null;
  const roles = [...new Set(input.targetRoles ?? ALERT_ROLES)];
  if (!KIND.test(input.kind) || !SEVERITIES.includes(input.severity) || !title || !LINK.test(input.linkPath) || input.linkPath.includes("..") || roles.length === 0) {
    throw new Error("invalid admin alert");
  }
  const data = { kind: input.kind, severity: input.severity, sellerId: input.sellerId ?? null, title, body, linkPath: input.linkPath, targetRoles: roles, dedupeKey: input.dedupeKey ?? null, occurredAt: input.occurredAt ?? new Date() };
  if (!data.dedupeKey) return { created: true as const, id: (await db.adminAlert.create({ data, select: { id: true } })).id };
  const rows = await db.adminAlert.createManyAndReturn({ data: [data], skipDuplicates: true, select: { id: true } });
  if (rows[0]) return { created: true as const, id: rows[0].id };
  const cur = await db.adminAlert.findUnique({ where: { dedupeKey: data.dedupeKey }, select: { id: true } });
  return { created: false as const, id: cur?.id ?? null };
}

export type AdminAlertRejection = "invalid_status" | "invalid_severity" | "invalid_assignee" | "invalid_cursor" | "invalid_status_change";

export const ADMIN_ALERT_MESSAGES: Record<AdminAlertRejection, string> = {
  invalid_status: "상태를 다시 선택해 주십시오",
  invalid_severity: "심각도를 다시 선택해 주십시오",
  invalid_assignee: "담당자를 다시 선택해 주십시오",
  invalid_cursor: "목록을 다시 불러와 주십시오",
  invalid_status_change: "상태를 다시 선택해 주십시오",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

function parseCursor(cursor: string | null | undefined): { ok: true; where: Prisma.AdminAlertWhereInput } | { ok: false } {
  if (!cursor) return { ok: true, where: {} };
  const i = cursor.lastIndexOf("_");
  const at = new Date(cursor.slice(0, i));
  const id = cursor.slice(i + 1);
  if (i <= 0 || Number.isNaN(at.getTime()) || !isUuid(id)) return { ok: false };
  return { ok: true, where: { OR: [{ occurredAt: { lt: at } }, { occurredAt: at, id: { lt: id } }] } };
}

const visible = (admin: AdminSessionContext): Prisma.AdminAlertWhereInput => ({ targetRoles: { has: admin.admin.role } });

// MA-002: 알림 목록. 쿼리 status·severity·kind·assignee(me|none|관리자 id)·cursor. 발생 최신순 50건.
// → { items: [{ id, kind, severity, title, body, linkPath, sellerId, shopName, status, assignee: {id,name}|null, occurredAt, resolvedAt, unread }],
//     counts: { OPEN, IN_PROGRESS, RESOLVED }(내가 볼 수 있는 알림 전체), unreadCount(안 읽은 알림 수), nextCursor }
export async function listAdminAlerts(
  db: PrismaClient,
  admin: AdminSessionContext,
  q: { status?: string | null; severity?: string | null; kind?: string | null; assignee?: string | null; cursor?: string | null },
) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  if (q.status && !STATUSES.includes(q.status as AdminAlertStatus)) return { ok: false as const, reason: "invalid_status" as const };
  if (q.severity && !SEVERITIES.includes(q.severity as AdminAlertSeverity)) return { ok: false as const, reason: "invalid_severity" as const };
  if (q.assignee && q.assignee !== "me" && q.assignee !== "none" && !isUuid(q.assignee)) return { ok: false as const, reason: "invalid_assignee" as const };
  const c = parseCursor(q.cursor);
  if (!c.ok) return { ok: false as const, reason: "invalid_cursor" as const };
  const assignee: Prisma.AdminAlertWhereInput = !q.assignee ? {} : q.assignee === "none" ? { assignedAdminId: null } : { assignedAdminId: q.assignee === "me" ? admin.admin.id : q.assignee };
  const mine = visible(admin);
  const rows = await db.adminAlert.findMany({
    where: {
      AND: [mine, assignee, c.where],
      ...(q.status ? { status: q.status as AdminAlertStatus } : {}),
      ...(q.severity ? { severity: q.severity as AdminAlertSeverity } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    include: { reads: { where: { adminId: admin.admin.id }, select: { adminId: true } } },
  });
  const page = rows.slice(0, PAGE_SIZE);
  const adminIds = [...new Set(page.map((r) => r.assignedAdminId).filter((v): v is string => !!v))];
  const sellerIds = [...new Set(page.map((r) => r.sellerId).filter((v): v is string => !!v))];
  const [admins, sellers, grouped, unreadCount] = await Promise.all([
    adminIds.length ? db.platformAdmin.findMany({ where: { id: { in: adminIds } }, select: { id: true, name: true } }) : [],
    sellerIds.length ? db.seller.findMany({ where: { id: { in: sellerIds } }, select: { id: true, shopName: true } }) : [],
    db.adminAlert.groupBy({ by: ["status"], where: mine, _count: { _all: true } }),
    db.adminAlert.count({ where: { ...mine, reads: { none: { adminId: admin.admin.id } } } }),
  ]);
  const adminName = new Map(admins.map((a) => [a.id, a.name]));
  const shopName = new Map(sellers.map((s) => [s.id, s.shopName]));
  return {
    ok: true as const,
    items: page.map(({ reads, targetRoles: _roles, dedupeKey: _key, assignedAdminId, createdAt: _created, ...r }) => ({
      ...r,
      shopName: r.sellerId ? (shopName.get(r.sellerId) ?? null) : null,
      assignee: assignedAdminId ? { id: assignedAdminId, name: adminName.get(assignedAdminId) ?? null } : null,
      unread: reads.length === 0,
    })),
    counts: Object.fromEntries(STATUSES.map((s) => [s, grouped.find((g) => g.status === s)?._count._all ?? 0])) as Record<AdminAlertStatus, number>,
    unreadCount,
    nextCursor: rows.length > PAGE_SIZE ? `${page[PAGE_SIZE - 1].occurredAt.toISOString()}_${page[PAGE_SIZE - 1].id}` : null,
  };
}

// 읽음(관리자마다). 내가 볼 수 없는 알림·없는 알림은 null(404). 이미 읽었으면 그대로 성공.
export async function markAlertRead(db: PrismaClient, admin: AdminSessionContext, id: string) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  if (!isUuid(id)) return null;
  const a = await db.adminAlert.findFirst({ where: { id, ...visible(admin) }, select: { id: true } });
  if (!a) return null;
  await db.adminAlertRead.createMany({ data: [{ adminId: admin.admin.id, alertId: id }], skipDuplicates: true });
  return { ok: true as const };
}

// 내가 볼 수 있는 안 읽은 알림 전부를 읽음으로. → { marked }
export async function markAllAlertsRead(db: PrismaClient, admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  const unread = await db.adminAlert.findMany({ where: { ...visible(admin), reads: { none: { adminId: admin.admin.id } } }, select: { id: true } });
  if (unread.length === 0) return { ok: true as const, marked: 0 };
  const r = await db.adminAlertRead.createMany({ data: unread.map((a) => ({ adminId: admin.admin.id, alertId: a.id })), skipDuplicates: true });
  return { ok: true as const, marked: r.count };
}

// 상태 변경. 본문 { status: OPEN|IN_PROGRESS|RESOLVED }. 최고관리자·운영·CS(support.assign). 로그 추적 admin_alert.status.
// IN_PROGRESS로 바꾸면 담당이 없을 때 바꾼 사람이 담당이 된다. RESOLVED는 resolvedAt을 남기고, OPEN으로 되돌리면 resolvedAt을 지운다.
export async function setAlertStatus(db: PrismaClient, admin: AdminSessionContext, id: string, raw: unknown, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  if (!adminCan(admin.admin.role, "support.assign")) throw forbidden();
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  const status = (raw && typeof raw === "object" ? (raw as Record<string, unknown>).status : undefined) as AdminAlertStatus | undefined;
  if (!status || !STATUSES.includes(status)) return { ok: false as const, reason: "invalid_status_change" as const };
  return db.$transaction(async (tx) => {
    const [cur] = await tx.$queryRaw<{ id: string; status: AdminAlertStatus; assignedAdminId: string | null; targetRoles: PlatformAdminRole[] }[]>`
      SELECT "id", "status", "assignedAdminId", "targetRoles" FROM "AdminAlert" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (!cur || !cur.targetRoles.includes(admin.admin.role)) return { ok: false as const, reason: "not_found" as const };
    if (cur.status === status) return { ok: true as const };
    const assign = status === "IN_PROGRESS" && cur.assignedAdminId === null;
    await tx.adminAlert.update({
      where: { id },
      data: { status, resolvedAt: status === "RESOLVED" ? new Date() : null, ...(assign ? { assignedAdminId: admin.admin.id } : {}) },
    });
    await writeAudit(tx, {
      actorType: "PLATFORM_ADMIN",
      actorId: admin.admin.id,
      action: "admin_alert.status",
      targetType: "AdminAlert",
      targetId: id,
      before: { status: cur.status },
      after: { status, ...(assign ? { assigneeId: admin.admin.id } : {}) },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const };
  });
}
