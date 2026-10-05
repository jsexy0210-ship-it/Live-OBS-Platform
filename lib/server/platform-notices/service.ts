import type { PlatformNotice, PlatformNoticeAudience, PlatformNoticeCategory, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import type { AdminSessionContext } from "../auth/session";
import { forbidden, notFound } from "../authz/errors";
import { adminCan } from "../authz/permissions";
import { cleanText } from "../text/clean";

// 플랫폼 공지(마스터 MA-053·054 작성 · 파트너스 SA-111·112 · 공개 PF-005·006). 규칙:
// - 보기는 마스터 관리자 모든 역할(platform.read), 쓰기·게시·삭제는 최고관리자·CS(support.manage, ARCHITECTURE 3.2 「공지 작성」).
//   바꿀 때마다 로그 추적에 전후를 남긴다.
// - 임시 저장(publishedAt 없음)은 마스터 관리자 화면에서만 보인다. 게시하면 대상에 따라 파트너스 관리자·공개 공지에 보인다.
//   대상 PARTNERS는 파트너스만, PUBLIC은 공개만, ALL은 둘 다. 지운 공지(deletedAt)는 어디에도 안 보인다.
// - 고정 공지는 목록 첫 쪽 위에 따로(pinned) 준다. 나머지는 게시일 최신순 커서(20건).
// - 다른 창에서 먼저 고쳤으면 version이 달라 409(지금 version).
// - 발송 채널은 지금 「공지 화면」뿐이다(channels: ["IN_APP"]). 메일 발송은 비용이 드는 발송이라 이번에 만들지 않는다.

type Db = PrismaClient | Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };

export const TITLE_MAX = 100;
export const BODY_MAX = 10_000;
export const PAGE_SIZE = 20;
export const CATEGORIES = ["MAINTENANCE", "POLICY", "FEATURE", "GENERAL"] as const satisfies readonly PlatformNoticeCategory[];
export const AUDIENCES = ["PARTNERS", "PUBLIC", "ALL"] as const satisfies readonly PlatformNoticeAudience[];
export const CHANNELS = ["IN_APP"] as const;

export type PlatformNoticeRejection = "invalid_title" | "invalid_body" | "invalid_category" | "invalid_audience" | "invalid_cursor" | "version_conflict";

// 마스터 관리자 화면 문구(명사형·합니다체)
export const PLATFORM_NOTICE_MESSAGES: Record<PlatformNoticeRejection, string> = {
  invalid_title: `제목을 ${TITLE_MAX}자 안에서 입력해 주십시오`,
  invalid_body: `내용을 ${BODY_MAX}자 안에서 입력해 주십시오`,
  invalid_category: "분류를 선택해 주십시오",
  invalid_audience: "보는 곳을 선택해 주십시오",
  invalid_cursor: "목록을 다시 불러와 주십시오",
  version_conflict: "다른 곳에서 먼저 고쳤습니다. 새로고침한 뒤 다시 시도해 주십시오",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const obj = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

type Input = { title: string; body: string; category: PlatformNoticeCategory; audience: PlatformNoticeAudience; isPinned: boolean; publish: boolean };

function parseInput(raw: unknown): { ok: true; v: Input } | { ok: false; reason: PlatformNoticeRejection } {
  const b = obj(raw);
  const title = cleanText(b.title, TITLE_MAX, "memo");
  if (!title) return { ok: false, reason: "invalid_title" };
  const body = cleanText(b.body, BODY_MAX, "multiline");
  if (!body) return { ok: false, reason: "invalid_body" };
  if (!CATEGORIES.includes(b.category as PlatformNoticeCategory)) return { ok: false, reason: "invalid_category" };
  if (!AUDIENCES.includes(b.audience as PlatformNoticeAudience)) return { ok: false, reason: "invalid_audience" };
  return {
    ok: true,
    v: { title, body, category: b.category as PlatformNoticeCategory, audience: b.audience as PlatformNoticeAudience, isPinned: b.isPinned === true, publish: b.publish === true },
  };
}

const adminView = (r: PlatformNotice) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  category: r.category,
  audience: r.audience,
  isPinned: r.isPinned,
  status: r.publishedAt ? ("published" as const) : ("draft" as const),
  publishedAt: r.publishedAt,
  channels: [...CHANNELS],
  version: r.version,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const readerView = (r: PlatformNotice) => ({
  id: r.id,
  title: r.title,
  body: r.body,
  category: r.category,
  isPinned: r.isPinned,
  publishedAt: r.publishedAt!,
  channels: [...CHANNELS],
});
const listView = ({ body: _body, ...rest }: ReturnType<typeof readerView>) => rest;
const auditView = (r: PlatformNotice) => ({ title: r.title, category: r.category, audience: r.audience, isPinned: r.isPinned, published: !!r.publishedAt, deleted: !!r.deletedAt });

function audit(db: Db, admin: AdminSessionContext, meta: AuditMeta, action: string, targetId: string, before: unknown, after: unknown) {
  return writeAudit(db, { actorType: "PLATFORM_ADMIN", actorId: admin.admin.id, action, targetType: "PlatformNotice", targetId, before, after, ip: meta.ip, userAgent: meta.userAgent });
}

function requireWriter(admin: AdminSessionContext) {
  if (!adminCan(admin.admin.role, "support.manage")) throw forbidden();
}

// 커서: 「정렬 시각 ISO_id」
function parseCursor(raw: string | null | undefined): { at: Date; id: string } | null | "invalid" {
  if (!raw) return null;
  const i = raw.lastIndexOf("_");
  const at = new Date(raw.slice(0, i));
  const id = raw.slice(i + 1);
  return i > 0 && !Number.isNaN(at.getTime()) && isUuid(id) ? { at, id } : "invalid";
}
const cursorOf = (at: Date, id: string) => `${at.toISOString()}_${id}`;

// ───────── 마스터 관리자 ─────────

export async function listAdminNotices(db: PrismaClient, admin: AdminSessionContext, q: { status?: string | null; cursor?: string | null }) {
  const c = parseCursor(q.cursor);
  if (c === "invalid") return { ok: false as const, reason: "invalid_cursor" as const };
  const where: Prisma.PlatformNoticeWhereInput = {
    deletedAt: null,
    ...(q.status === "draft" ? { publishedAt: null } : q.status === "published" ? { publishedAt: { not: null } } : {}),
    ...(c ? { OR: [{ createdAt: { lt: c.at } }, { createdAt: c.at, id: { lt: c.id } }] } : {}),
  };
  const rows = await db.platformNotice.findMany({ where, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PAGE_SIZE + 1 });
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return { ok: true as const, items: page.map(adminView), nextCursor: rows.length > PAGE_SIZE && last ? cursorOf(last.createdAt, last.id) : null };
}

export async function getAdminNotice(db: PrismaClient, _admin: AdminSessionContext, id: string) {
  if (!isUuid(id)) throw notFound();
  const row = await db.platformNotice.findFirst({ where: { id, deletedAt: null } });
  if (!row) throw notFound();
  return adminView(row);
}

export async function createPlatformNotice(db: PrismaClient, admin: AdminSessionContext, raw: unknown, meta: AuditMeta = {}) {
  requireWriter(admin);
  const p = parseInput(raw);
  if (!p.ok) return p;
  const { publish, ...data } = p.v;
  return db.$transaction(async (tx) => {
    const row = await tx.platformNotice.create({
      data: { ...data, publishedAt: publish ? new Date() : null, createdByAdminId: admin.admin.id, updatedByAdminId: admin.admin.id },
    });
    await audit(tx, admin, meta, "platform.notice.create", row.id, undefined, auditView(row));
    return { ok: true as const, notice: adminView(row) };
  });
}

// 고치기. 본문은 만들 때와 같고 expectedVersion을 함께 보낸다. publish: true면 게시(이미 게시된 공지는 처음 게시일 유지), false면 임시 저장으로 내린다.
export async function updatePlatformNotice(db: PrismaClient, admin: AdminSessionContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireWriter(admin);
  if (!isUuid(id)) throw notFound();
  const p = parseInput(raw);
  if (!p.ok) return p;
  const expected = obj(raw).expectedVersion;
  const { publish, ...data } = p.v;
  return db.$transaction(async (tx) => {
    const [before] = await tx.$queryRaw<PlatformNotice[]>`SELECT * FROM "PlatformNotice" WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (!before) throw notFound();
    if (expected !== before.version) return { ok: false as const, reason: "version_conflict" as const, currentVersion: before.version };
    const row = await tx.platformNotice.update({
      where: { id },
      data: { ...data, publishedAt: publish ? (before.publishedAt ?? new Date()) : null, version: { increment: 1 }, updatedByAdminId: admin.admin.id },
    });
    await audit(tx, admin, meta, "platform.notice.update", id, auditView(before), auditView(row));
    return { ok: true as const, notice: adminView(row) };
  });
}

export async function deletePlatformNotice(db: PrismaClient, admin: AdminSessionContext, id: string, expectedVersion: unknown, meta: AuditMeta = {}) {
  requireWriter(admin);
  if (!isUuid(id)) throw notFound();
  return db.$transaction(async (tx) => {
    const [before] = await tx.$queryRaw<PlatformNotice[]>`SELECT * FROM "PlatformNotice" WHERE "id" = ${id}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (!before) throw notFound();
    if (expectedVersion !== before.version) return { ok: false as const, reason: "version_conflict" as const, currentVersion: before.version };
    const row = await tx.platformNotice.update({ where: { id }, data: { deletedAt: new Date(), version: { increment: 1 }, updatedByAdminId: admin.admin.id } });
    await audit(tx, admin, meta, "platform.notice.delete", id, auditView(before), auditView(row));
    return { ok: true as const };
  });
}

// ───────── 파트너스 관리자·공개 ─────────

export type NoticeReader = "partners" | "public";
const readerWhere = (reader: NoticeReader): Prisma.PlatformNoticeWhereInput => ({
  deletedAt: null,
  publishedAt: { not: null },
  audience: { in: reader === "partners" ? ["PARTNERS", "ALL"] : ["PUBLIC", "ALL"] },
});

// 첫 쪽(cursor 없음)에만 고정 공지(pinned, 최신순)를 따로 주고, items는 고정이 아닌 공지 게시일 최신순 20건
export async function listNotices(db: PrismaClient, reader: NoticeReader, q: { cursor?: string | null }) {
  const c = parseCursor(q.cursor);
  if (c === "invalid") return { ok: false as const, reason: "invalid_cursor" as const };
  const base = readerWhere(reader);
  const order: Prisma.PlatformNoticeOrderByWithRelationInput[] = [{ publishedAt: "desc" }, { id: "desc" }];
  const pinned = c ? [] : await db.platformNotice.findMany({ where: { ...base, isPinned: true }, orderBy: order });
  const rows = await db.platformNotice.findMany({
    where: { ...base, isPinned: false, ...(c ? { OR: [{ publishedAt: { lt: c.at } }, { publishedAt: c.at, id: { lt: c.id } }] } : {}) },
    orderBy: order,
    take: PAGE_SIZE + 1,
  });
  const page = rows.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    ok: true as const,
    pinned: pinned.map((r) => listView(readerView(r))),
    items: page.map((r) => listView(readerView(r))),
    nextCursor: rows.length > PAGE_SIZE && last ? cursorOf(last.publishedAt!, last.id) : null,
  };
}

export async function getNotice(db: PrismaClient, reader: NoticeReader, id: string) {
  if (!isUuid(id)) throw notFound();
  const row = await db.platformNotice.findFirst({ where: { id, ...readerWhere(reader) } });
  if (!row) throw notFound();
  return readerView(row);
}
