import type { ActorType, Prisma, PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../auth/session";
import { forbidden } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { decodeCursor, encodeCursor, kstDayStart } from "../orders/read";

// 마스터 관리자 로그 추적(MA-070·071, 코드·DB 이름은 audit). audit.read(최고관리자·운영·조회 전용, CS 제외). 조회만 한다.
// 목록은 기록 시각 내림차순 (createdAt, id) 커서이고 바뀐 값(before·after)은 넣지 않는다(상세에서만).
export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;
const ACTOR_TYPES: readonly ActorType[] = ["PLATFORM_ADMIN", "SELLER_USER", "BUYER", "SYSTEM"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_RE = /^[a-z0-9_.]{1,100}$/;
const DAY_MS = 86_400_000;

function requireRead(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "audit.read")) throw forbidden();
}

export type AuditLogQuery = {
  action?: string | null;
  actorType?: string | null;
  actorId?: string | null;
  sellerId?: string | null;
  targetId?: string | null;
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
  limit?: string | null;
};

const LIST_SELECT = {
  id: true,
  createdAt: true,
  actorType: true,
  actorId: true,
  action: true,
  targetType: true,
  targetId: true,
  reason: true,
  ip: true,
  userAgent: true,
  seller: { select: { id: true, slug: true, shopName: true } },
} as const satisfies Prisma.AuditLogSelect;

// action: 정확히 같은 값, 또는 「.」으로 끝나면 그 접두어(예: admin.seller.). from·to: KST 날짜(기록 시각, 끝 날짜 포함).
export async function listAuditLogs(db: PrismaClient, admin: AdminSessionContext, query: AuditLogQuery) {
  requireRead(admin);
  const n = query.limit == null || query.limit === "" ? AUDIT_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(n) || n < 1) return { ok: false as const };
  const take = Math.min(n, AUDIT_PAGE_MAX);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  if (query.action && !ACTION_RE.test(query.action)) return { ok: false as const };
  if (query.actorType && !ACTOR_TYPES.includes(query.actorType as ActorType)) return { ok: false as const };
  for (const id of [query.actorId, query.sellerId]) if (id && !UUID_RE.test(id)) return { ok: false as const };
  if (query.targetId && query.targetId.length > 100) return { ok: false as const };
  const from = query.from ? kstDayStart(query.from) : null;
  const toStart = query.to ? kstDayStart(query.to) : null;
  if ((query.from && !from) || (query.to && !toStart)) return { ok: false as const };

  const and: Prisma.AuditLogWhereInput[] = [];
  if (query.action) and.push(query.action.endsWith(".") ? { action: { startsWith: query.action } } : { action: query.action });
  if (query.actorType) and.push({ actorType: query.actorType as ActorType });
  if (query.actorId) and.push({ actorId: query.actorId });
  if (query.sellerId) and.push({ sellerId: query.sellerId });
  if (query.targetId) and.push({ targetId: query.targetId });
  if (from) and.push({ createdAt: { gte: from } });
  if (toStart) and.push({ createdAt: { lt: new Date(toStart.getTime() + DAY_MS) } });
  if (cursor) and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });
  const rows = await db.auditLog.findMany({ where: { AND: and }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, select: LIST_SELECT });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  return { ok: true as const, logs: page, nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null };
}

// 상세: 목록 항목 + 바뀐 값(before·after). 행위자가 관리자면 이름·이메일을 붙인다. 없으면 null.
export async function getAuditLog(db: PrismaClient, admin: AdminSessionContext, id: string) {
  requireRead(admin);
  const log = await db.auditLog.findUnique({ where: { id }, select: { ...LIST_SELECT, before: true, after: true } });
  if (!log) return null;
  const actor =
    log.actorType === "PLATFORM_ADMIN" && log.actorId
      ? await db.platformAdmin.findUnique({ where: { id: log.actorId }, select: { name: true, email: true, role: true } })
      : null;
  return { ...log, actorAdmin: actor };
}
