import type { Prisma, PrismaClient, ShopNotice, ShopNoticeKind } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { shopOpen } from "../buyers/signup";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 쇼핑몰 공지·자주 묻는 질문(SA-066 관리 · SH-030 구매자 조회). 규칙:
// - 조회는 같은 쇼핑몰 파트너스 계정 누구나, 쓰기는 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 직원만. 바꿀 때마다 로그 추적(감사 로그)에 남긴다.
// - 공지는 최신순. 홈 띠 고정 공지는 쇼핑몰당 1개(공개 공지만): 새로 고정하면 이전 고정은 풀린다. 비공개로 바꾸면 고정도 풀린다.
// - 질문은 분류(선택)와 순서(sortOrder)가 있고, 구매자 화면은 순서대로 본문까지 한 번에 받는다(접고 펼치기). 검색어로 좁힐 수 있다(문의 작성 전 제안).
// - 쓰기는 쇼핑몰 행 잠금 아래에서 개수·고정·순서를 판단한다.
// - 구매자 조회는 로그인 없이, 운영 중인 쇼핑몰(shopOpen)의 공개 글만.

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };

export const NOTICE_LIMIT = 200;
export const FAQ_LIMIT = 100;
export const TITLE_MAX = 60;
export const BODY_MAX = 5000;
export const CATEGORY_MAX = 20;
export const PUBLIC_PAGE_SIZE = 20;

export type NoticeRejection = "invalid_kind" | "invalid_title" | "invalid_body" | "invalid_category" | "invalid_pin" | "too_many" | "order_conflict";

// 파트너스 관리자 화면 문구(명사형·합니다체)
export const NOTICE_MESSAGES: Record<NoticeRejection, string> = {
  invalid_kind: "공지 또는 자주 묻는 질문 중 하나를 선택해 주십시오",
  invalid_title: `제목은 ${TITLE_MAX}자까지 입력할 수 있습니다`,
  invalid_body: `내용을 ${BODY_MAX}자 안에서 입력해 주십시오`,
  invalid_category: `분류는 ${CATEGORY_MAX}자까지 입력할 수 있습니다`,
  invalid_pin: "홈 띠 고정은 공개한 공지만 할 수 있습니다",
  too_many: "더 추가할 수 없습니다. 쓰지 않는 글을 삭제해 주십시오",
  order_conflict: "다른 곳에서 목록이 바뀌었습니다. 새로고침한 뒤 다시 시도해 주십시오",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
const obj = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const lockSeller = (tx: Tx, sellerId: string) => tx.$queryRaw`SELECT 1 FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR UPDATE`;

export function parseKind(v: unknown): ShopNoticeKind | null {
  return v === "notice" ? "NOTICE" : v === "faq" ? "FAQ" : null;
}

type Input = { title: string; body: string; category: string | null; isPinned: boolean; isPublished: boolean };

function parseInput(kind: ShopNoticeKind, raw: unknown): { ok: true; v: Input } | { ok: false; reason: NoticeRejection } {
  const b = obj(raw);
  const title = cleanText(b.title, TITLE_MAX, "memo");
  if (!title) return { ok: false, reason: "invalid_title" };
  const body = cleanText(b.body, BODY_MAX, "multiline");
  if (!body) return { ok: false, reason: "invalid_body" };
  let category: string | null = null;
  if (b.category !== undefined && b.category !== null && !(typeof b.category === "string" && b.category.trim() === "")) {
    category = cleanText(b.category, CATEGORY_MAX);
    if (!category) return { ok: false, reason: "invalid_category" };
  }
  const isPublished = typeof b.isPublished === "boolean" ? b.isPublished : true;
  const isPinned = b.isPinned === true;
  if (isPinned && (kind !== "NOTICE" || !isPublished)) return { ok: false, reason: "invalid_pin" };
  return { ok: true, v: { title, body, category, isPinned, isPublished } };
}

const view = (r: ShopNotice) => ({
  id: r.id,
  kind: r.kind === "NOTICE" ? ("notice" as const) : ("faq" as const),
  title: r.title,
  body: r.body,
  category: r.category,
  isPinned: r.isPinned,
  isPublished: r.isPublished,
  sortOrder: r.sortOrder,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const auditView = (r: ShopNotice) => ({ kind: r.kind, title: r.title, category: r.category, isPinned: r.isPinned, isPublished: r.isPublished, sortOrder: r.sortOrder });

function audit(db: Db, ctx: TenantContext, meta: AuditMeta, action: string, targetId: string, before: unknown, after: unknown) {
  return writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "ShopNotice", targetId, before, after, ip: meta.ip, userAgent: meta.userAgent });
}

const orderBy = (kind: ShopNoticeKind): Prisma.ShopNoticeOrderByWithRelationInput[] =>
  kind === "NOTICE" ? [{ createdAt: "desc" }, { id: "desc" }] : [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }];

// ───────── 파트너스 관리자 ─────────

export async function listSellerNotices(db: PrismaClient, ctx: TenantContext, kind: ShopNoticeKind) {
  const rows = await db.shopNotice.findMany({ where: { sellerId: ctx.sellerId, kind }, orderBy: orderBy(kind) });
  return rows.map(view);
}

// 새로 고정하면 같은 쇼핑몰의 이전 고정을 푼다(쇼핑몰 행 잠금 아래)
async function unpinOthers(tx: Tx, ctx: TenantContext, meta: AuditMeta, exceptId?: string) {
  const pinned = await tx.shopNotice.findMany({ where: { sellerId: ctx.sellerId, isPinned: true, ...(exceptId ? { id: { not: exceptId } } : {}) } });
  for (const p of pinned) {
    const row = await tx.shopNotice.update({ where: { id: p.id }, data: { isPinned: false } });
    await audit(tx, ctx, meta, "shop.notice.update", p.id, auditView(p), auditView(row));
  }
}

export async function createNotice(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const kind = parseKind(obj(raw).kind);
  if (!kind) return { ok: false as const, reason: "invalid_kind" as const };
  const p = parseInput(kind, raw);
  if (!p.ok) return p;
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    if ((await tx.shopNotice.count({ where: { sellerId: ctx.sellerId, kind } })) >= (kind === "NOTICE" ? NOTICE_LIMIT : FAQ_LIMIT)) return { ok: false as const, reason: "too_many" as const };
    if (p.v.isPinned) await unpinOthers(tx, ctx, meta);
    const last = kind === "FAQ" ? await tx.shopNotice.aggregate({ where: { sellerId: ctx.sellerId, kind }, _max: { sortOrder: true } }) : null;
    const row = await tx.shopNotice.create({ data: { sellerId: ctx.sellerId, kind, ...p.v, sortOrder: last ? (last._max.sortOrder ?? -1) + 1 : 0 } });
    await audit(tx, ctx, meta, "shop.notice.create", row.id, undefined, auditView(row));
    return { ok: true as const, notice: view(row) };
  });
}

// 고치기. 본문은 만들 때와 같다(kind는 바꿀 수 없음, 보내도 무시).
export async function updateNotice(db: PrismaClient, ctx: TenantContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!isUuid(id)) throw notFound();
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const before = await tx.shopNotice.findFirst({ where: { id, sellerId: ctx.sellerId } });
    if (!before) throw notFound();
    const p = parseInput(before.kind, raw);
    if (!p.ok) return p;
    if (p.v.isPinned) await unpinOthers(tx, ctx, meta, id);
    const row = await tx.shopNotice.update({ where: { id }, data: p.v });
    await audit(tx, ctx, meta, "shop.notice.update", id, auditView(before), auditView(row));
    return { ok: true as const, notice: view(row) };
  });
}

export async function deleteNotice(db: PrismaClient, ctx: TenantContext, id: string, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!isUuid(id)) throw notFound();
  await db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const before = await tx.shopNotice.findFirst({ where: { id, sellerId: ctx.sellerId } });
    if (!before) throw notFound();
    await tx.shopNotice.delete({ where: { id } });
    await audit(tx, ctx, meta, "shop.notice.delete", id, auditView(before), undefined);
  });
}

// 질문 순서 바꾸기. 본문: { ids: [질문 id 전부, 원하는 순서] }. 목록이 그사이 바뀌었으면 order_conflict.
export async function reorderFaqs(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const ids = obj(raw).ids;
  if (!Array.isArray(ids) || ids.length > FAQ_LIMIT || !ids.every(isUuid) || new Set(ids).size !== ids.length) return { ok: false as const, reason: "order_conflict" as const };
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const rows = await tx.shopNotice.findMany({ where: { sellerId: ctx.sellerId, kind: "FAQ" }, select: { id: true, sortOrder: true } });
    const have = new Set(rows.map((r) => r.id));
    if (rows.length !== ids.length || !ids.every((id) => have.has(id))) return { ok: false as const, reason: "order_conflict" as const };
    for (const [i, id] of (ids as string[]).entries()) await tx.shopNotice.update({ where: { id }, data: { sortOrder: i } });
    await audit(tx, ctx, meta, "shop.faq.reorder", ctx.sellerId, rows.sort((a, b) => a.sortOrder - b.sortOrder).map((r) => r.id), ids);
    const after = await tx.shopNotice.findMany({ where: { sellerId: ctx.sellerId, kind: "FAQ" }, orderBy: orderBy("FAQ") });
    return { ok: true as const, faqs: after.map(view) };
  });
}

// ───────── 구매자(로그인 없이) ─────────

async function openShop(db: PrismaClient, slug: string) {
  const shop = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  return shop && (await shopOpen(db, shop.id)) ? shop.id : null;
}

// 공지 목록(최신순, ?cursor=마지막 공지 id). 고정 공지(홈 띠)는 pinned로 따로 준다. 본문은 상세에서.
export async function publicNotices(db: PrismaClient, slug: string, cursor?: string | null) {
  const sellerId = await openShop(db, slug);
  if (!sellerId) return null;
  const where = { sellerId, kind: "NOTICE" as const, isPublished: true };
  const at = isUuid(cursor) ? await db.shopNotice.findFirst({ where: { ...where, id: cursor }, select: { id: true, createdAt: true } }) : null;
  const [pinned, rows] = await Promise.all([
    db.shopNotice.findFirst({ where: { ...where, isPinned: true }, select: { id: true, title: true, category: true, createdAt: true } }),
    db.shopNotice.findMany({
      where: { ...where, ...(at ? { OR: [{ createdAt: { lt: at.createdAt } }, { createdAt: at.createdAt, id: { lt: at.id } }] } : {}) },
      orderBy: orderBy("NOTICE"),
      take: PUBLIC_PAGE_SIZE + 1,
      select: { id: true, title: true, category: true, isPinned: true, createdAt: true },
    }),
  ]);
  const notices = rows.slice(0, PUBLIC_PAGE_SIZE);
  return { pinned, notices, nextCursor: rows.length > PUBLIC_PAGE_SIZE ? notices[notices.length - 1].id : null };
}

export async function publicNotice(db: PrismaClient, slug: string, id: string) {
  const sellerId = await openShop(db, slug);
  if (!sellerId || !isUuid(id)) return null;
  return db.shopNotice.findFirst({ where: { id, sellerId, kind: "NOTICE", isPublished: true }, select: { id: true, title: true, body: true, category: true, isPinned: true, createdAt: true, updatedAt: true } });
}

// 자주 묻는 질문(순서대로, 본문 포함). ?q=검색어(제목·본문·분류, 2~40자)로 좁히면 문의 작성 전 제안에 쓴다. categories는 쓰인 분류(첫 등장 순).
export async function publicFaqs(db: PrismaClient, slug: string, q?: string | null) {
  const sellerId = await openShop(db, slug);
  if (!sellerId) return null;
  const term = q?.trim().slice(0, 40) ?? "";
  const search =
    term.length >= 2
      ? { OR: [{ title: { contains: term, mode: "insensitive" as const } }, { body: { contains: term, mode: "insensitive" as const } }, { category: { contains: term, mode: "insensitive" as const } }] }
      : {};
  const faqs = await db.shopNotice.findMany({ where: { sellerId, kind: "FAQ", isPublished: true, ...search }, orderBy: orderBy("FAQ"), select: { id: true, category: true, title: true, body: true } });
  const categories = [...new Set(faqs.map((f) => f.category).filter((c): c is string => !!c))];
  return { faqs, categories };
}
