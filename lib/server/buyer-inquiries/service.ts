import { Prisma, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { sellerCan } from "../authz/permissions";
import { shopOpen } from "../buyers/signup";
import { WITHDRAWN_DISPLAY_NAME } from "../buyers/memberData";
import { checkReviewImage, type ReviewImageRejection } from "../product-reviews/image";
import { SHOP_VISIBLE_PRODUCT } from "../product-reviews/service";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 구매자 문의(상품 문의·1:1 문의, SA-046·047).
// - 구매자: 쓰기(상품 연결 선택·비공개·사진 5장까지), 내 목록, 답변 전에만 고치기·지우기. 쓰기 경로는 쇼핑몰 이용 가능 검사(shopOpen)를 거친다.
// - 파트너스: 조회는 같은 쇼핑몰 계정 누구나, 답변 쓰기·고치기·지우기는 대표자·구매자 문의(INQUIRY_REPLY) 직원. 답변을 지우면 다시 답변 대기.
// - 다른 판매자 문의·사진은 보이지 않는다. 로그 추적에는 글 내용을 남기지 않고 길이·사진 수만 남긴다.
// - 탈퇴: 작성자 표시를 「탈퇴한 회원」으로 바꾸고 사진은 지운다. 글은 판매자 응대 기록으로 남긴다(buyers/memberData.ts).
type Db = PrismaClient | Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };
export type BuyerScope = { sellerId: string; buyerMemberId: string };

export const INQUIRY_TITLE_MAX = 50;
export const INQUIRY_BODY_MAX = 2000;
export const INQUIRY_ANSWER_MAX = 1000;
export const INQUIRY_IMAGES_MAX = 5;
export const INQUIRY_PAGE = 20;
export const SELLER_INQUIRY_PAGE = 30;
export const INQUIRY_SEARCH_MAX = 50;
// 같은 구매자가 한 쇼핑몰에 1시간에 쓸 수 있는 문의 수
export const INQUIRY_RATE_LIMIT = 10;
export const INQUIRY_RATE_WINDOW_MS = 3_600_000;
// 소비자 불만·분쟁 처리 기록 보관 기간(전자상거래법 기준 3년, MASTER 2026-10-05). 탈퇴 뒤에도 글을 이 기간까지 남기며, 기간이 지난 글의 파기 작업은 법률 검토(출시 뒤)에서 정한 뒤 이 값을 쓴다.
export const INQUIRY_RETENTION_YEARS = 3;
const UNATTACHED_KEEP = 10;

export type BuyerInquiryFailure =
  | "shop_unavailable"
  | "invalid_kind"
  | "invalid_product"
  | "invalid_title"
  | "invalid_body"
  | "invalid_images"
  | "inquiry_not_found"
  | "already_answered"
  | "inquiry_rate_limited"
  | ReviewImageRejection
  | "file_too_large";
// 구매자 화면 문구(해요체)
export const BUYER_INQUIRY_MESSAGES: Record<BuyerInquiryFailure, string> = {
  shop_unavailable: "지금은 문의를 남길 수 없어요",
  invalid_kind: "문의 종류를 확인해 주세요",
  invalid_product: "문의할 상품을 확인해 주세요",
  invalid_title: `제목을 ${INQUIRY_TITLE_MAX}자 안으로 입력해 주세요`,
  invalid_body: `내용을 ${INQUIRY_BODY_MAX}자 안으로 입력해 주세요`,
  invalid_images: `사진은 ${INQUIRY_IMAGES_MAX}장까지 붙일 수 있어요`,
  inquiry_not_found: "문의를 찾을 수 없어요",
  already_answered: "답변이 달린 문의는 고치거나 지울 수 없어요",
  inquiry_rate_limited: "문의를 너무 많이 남겼어요. 잠시 뒤에 다시 시도해 주세요",
  empty_file: "사진 파일이 비어 있어요",
  file_too_large: "사진은 5MB 이하로 올려 주세요",
  unsupported_image: "JPG, PNG, WEBP 사진만 올릴 수 있어요",
  wrong_image_size: "사진 크기를 확인해 주세요",
  png_16bit: "이 PNG 사진은 올릴 수 없어요. 다른 사진을 골라 주세요",
  png_too_large: "사진이 너무 커요. 크기를 줄여 주세요",
};

export type SellerInquiryFailure = "invalid_answer" | "invalid_range" | "invalid_status";
// 파트너스 화면 문구(합니다체)
export const SELLER_INQUIRY_MESSAGES: Record<SellerInquiryFailure, string> = {
  invalid_answer: `답변을 ${INQUIRY_ANSWER_MAX}자 안으로 입력해 주십시오`,
  invalid_range: "조회 기간을 확인해 주십시오",
  invalid_status: "상태를 확인해 주십시오",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

async function lockedNow(tx: Db): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return rows[0].now;
}
const buyerAudit = (db: Db, s: BuyerScope, m: AuditMeta, action: string, targetId: string | undefined, after?: unknown) =>
  writeAudit(db, { actorType: "BUYER", actorId: s.buyerMemberId, sellerId: s.sellerId, action, targetType: targetId ? "BuyerInquiry" : undefined, targetId, after, ip: m.ip, userAgent: m.userAgent });
const sellerAudit = (db: Db, c: TenantContext, m: AuditMeta, action: string, id: string, before: unknown, after: unknown) =>
  writeAudit(db, { actorType: c.actorType, actorId: c.actorId, sellerId: c.sellerId, action, targetType: "BuyerInquiry", targetId: id, before, after, ip: m.ip, userAgent: m.userAgent });

// ───────── 보기 ─────────
type Row = Prisma.BuyerInquiryGetPayload<{ include: { images: { select: { id: true; width: true; height: true } }; product: { select: { id: true; name: true } } } }>;
const include = {
  images: { select: { id: true, width: true, height: true }, orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] },
  product: { select: { id: true, name: true } },
};

function view(r: Row, imageBase: string) {
  return {
    id: r.id,
    kind: r.kind,
    product: r.product,
    title: r.title,
    body: r.body,
    isPrivate: r.isPrivate,
    status: r.status,
    answer: r.answer,
    answeredAt: r.answeredAt,
    createdAt: r.createdAt,
    images: r.images.map((i) => ({ id: i.id, width: i.width, height: i.height, url: `${imageBase}/${i.id}` })),
  };
}
const sellerView = (r: Row, imageBase: string) => ({ ...view(r, imageBase), authorNickname: r.authorNickname });

const afterCursor = (c: { createdAt: Date; id: string } | null) => (c ? { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] } : {});

// ───────── 사진 ─────────
export async function uploadInquiryImage(db: PrismaClient, scope: BuyerScope, bytes: Buffer, meta: AuditMeta = {}) {
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  const c = checkReviewImage(bytes);
  if (!c.ok) return c;
  return db.$transaction(async (tx) => {
    const [member] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR UPDATE`;
    if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
    const old = await tx.buyerInquiryImage.findMany({ where: { ...scope, inquiryId: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: UNATTACHED_KEEP - 1, select: { id: true } });
    if (old.length > 0) await tx.buyerInquiryImage.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    const img = await tx.buyerInquiryImage.create({
      data: { ...scope, data: new Uint8Array(c.image.data), contentType: c.image.type, byteSize: c.image.data.length, width: c.image.width, height: c.image.height },
      select: { id: true, width: true, height: true },
    });
    await buyerAudit(tx, scope, meta, "buyer_inquiry.image_upload", undefined, { imageId: img.id, byteSize: c.image.data.length });
    return { ok: true as const, image: img };
  });
}

// 내가 올린 사진(문의에 붙은 사진 포함)
export async function buyerInquiryImage(db: PrismaClient, scope: BuyerScope, imageId: string) {
  if (!isUuid(imageId)) return null;
  return db.buyerInquiryImage.findFirst({ where: { id: imageId, ...scope }, select: { data: true, contentType: true } });
}
// 파트너스가 볼 수 있는 사진: 같은 쇼핑몰 문의에 붙은 사진만
export async function sellerInquiryImage(db: PrismaClient, ctx: TenantContext, imageId: string) {
  if (!isUuid(imageId)) return null;
  return db.buyerInquiryImage.findFirst({ where: { id: imageId, sellerId: ctx.sellerId, inquiryId: { not: null } }, select: { data: true, contentType: true } });
}

export const inquiryStatus = (r: BuyerInquiryFailure) =>
  r === "shop_unavailable" ? 402 : r === "inquiry_not_found" ? 404 : r === "already_answered" ? 409 : r === "inquiry_rate_limited" ? 429 : 400;

export function imageResponse(row: { data: Uint8Array; contentType: string } | null): Response {
  const base = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" };
  if (!row) return new Response("not found", { status: 404, headers: base });
  return new Response(new Uint8Array(row.data), { headers: { ...base, "content-type": row.contentType, "cache-control": "private, max-age=60" } });
}

// ───────── 입력 검사 ─────────
type Parsed = { title: string; body: string; isPrivate: boolean; imageIds: string[] };
function parseFields(raw: unknown): { ok: true; v: Parsed } | { ok: false; reason: BuyerInquiryFailure } {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const title = cleanText(b.title, INQUIRY_TITLE_MAX);
  if (!title) return { ok: false, reason: "invalid_title" };
  const body = cleanText(b.body, INQUIRY_BODY_MAX, "multiline");
  if (!body) return { ok: false, reason: "invalid_body" };
  if (b.isPrivate !== undefined && typeof b.isPrivate !== "boolean") return { ok: false, reason: "invalid_body" };
  const ids = b.imageIds === undefined ? [] : b.imageIds;
  if (!Array.isArray(ids) || ids.length > INQUIRY_IMAGES_MAX || !ids.every(isUuid) || new Set(ids).size !== ids.length) return { ok: false, reason: "invalid_images" };
  return { ok: true, v: { title, body, isPrivate: b.isPrivate === true, imageIds: ids as string[] } };
}

// 사진 연결: 내가 올린 붙지 않은 사진이거나 이 문의에 이미 붙은 사진만. 목록에 없는 기존 사진은 지운다.
async function attachImages(tx: Prisma.TransactionClient, scope: BuyerScope, inquiryId: string, imageIds: string[]) {
  const mine = await tx.buyerInquiryImage.findMany({ where: { ...scope, id: { in: imageIds }, OR: [{ inquiryId: null }, { inquiryId }] }, select: { id: true } });
  if (mine.length !== imageIds.length) return false;
  await tx.buyerInquiryImage.deleteMany({ where: { ...scope, inquiryId, id: { notIn: imageIds } } });
  for (const [i, id] of imageIds.entries()) await tx.buyerInquiryImage.update({ where: { id }, data: { inquiryId, sortOrder: i } });
  return true;
}

// ───────── 구매자 ─────────
export async function createInquiry(db: PrismaClient, scope: BuyerScope, raw: unknown, meta: AuditMeta = {}) {
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  const b = (raw && typeof raw === "object" ? raw : {}) as { kind?: unknown; productId?: unknown };
  if (b.kind !== "PRODUCT" && b.kind !== "GENERAL") return { ok: false as const, reason: "invalid_kind" as const };
  if (b.kind === "PRODUCT" ? !isUuid(b.productId) : b.productId !== undefined && b.productId !== null) return { ok: false as const, reason: "invalid_product" as const };
  const p = parseFields(raw);
  if (!p.ok) return p;
  const kind = b.kind;
  const productId = kind === "PRODUCT" ? (b.productId as string) : null;
  return db.$transaction(async (tx) => {
    // 회원 행을 쓰기 잠금으로 잡아 같은 회원의 동시 작성이 한도를 넘지 않게 하고, 탈퇴(FOR UPDATE)와도 엇갈리지 않게 한다
    const [member] = await tx.$queryRaw<{ id: string; broadcastNickname: string }[]>`
      SELECT "id", "broadcastNickname" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR UPDATE`;
    if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
    if (productId && !(await tx.product.findFirst({ where: { id: productId, sellerId: scope.sellerId, ...SHOP_VISIBLE_PRODUCT }, select: { id: true } }))) {
      return { ok: false as const, reason: "invalid_product" as const };
    }
    const now = await lockedNow(tx);
    const recent = await tx.buyerInquiry.count({ where: { ...scope, createdAt: { gt: new Date(now.getTime() - INQUIRY_RATE_WINDOW_MS) } } });
    if (recent >= INQUIRY_RATE_LIMIT) return { ok: false as const, reason: "inquiry_rate_limited" as const };
    const row = await tx.buyerInquiry.create({
      data: { ...scope, kind, productId, authorNickname: member.broadcastNickname, title: p.v.title, body: p.v.body, isPrivate: p.v.isPrivate, createdAt: now, updatedAt: now },
    });
    if (!(await attachImages(tx, scope, row.id, p.v.imageIds))) throw new InvalidImages();
    await buyerAudit(tx, scope, meta, "buyer_inquiry.create", row.id, { kind, productId, isPrivate: p.v.isPrivate, titleLength: p.v.title.length, bodyLength: p.v.body.length, photos: p.v.imageIds.length });
    return { ok: true as const, id: row.id };
  }).catch((e) => {
    if (e instanceof InvalidImages) return { ok: false as const, reason: "invalid_images" as const };
    throw e;
  });
}
class InvalidImages extends Error {}

export async function listMyInquiries(db: PrismaClient, scope: BuyerScope, q: { cursor?: string | null }, imageBase: string) {
  const at = isUuid(q.cursor) ? await db.buyerInquiry.findFirst({ where: { id: q.cursor, ...scope }, select: { createdAt: true, id: true } }) : null;
  const rows = await db.buyerInquiry.findMany({ where: { ...scope, ...afterCursor(at) }, include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: INQUIRY_PAGE + 1 });
  const page = rows.slice(0, INQUIRY_PAGE);
  return { inquiries: page.map((r) => view(r, imageBase)), nextCursor: rows.length > INQUIRY_PAGE ? page[page.length - 1].id : null };
}

export async function getMyInquiry(db: PrismaClient, scope: BuyerScope, id: string, imageBase: string) {
  if (!isUuid(id)) return null;
  const r = await db.buyerInquiry.findFirst({ where: { id, ...scope }, include });
  return r ? view(r, imageBase) : null;
}

// 잠금: 본인 문의 한 줄을 FOR UPDATE로 잡는다(답변과 고치기·지우기가 엇갈리지 않게)
async function lockOwn(tx: Prisma.TransactionClient, scope: BuyerScope, id: string) {
  const [row] = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status" FROM "BuyerInquiry" WHERE "id" = ${id}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "buyerMemberId" = ${scope.buyerMemberId}::uuid FOR UPDATE`;
  return row ?? null;
}

export async function updateInquiry(db: PrismaClient, scope: BuyerScope, id: string, raw: unknown, meta: AuditMeta = {}) {
  if (!isUuid(id)) return { ok: false as const, reason: "inquiry_not_found" as const };
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  const p = parseFields(raw);
  if (!p.ok) return p;
  return db.$transaction(async (tx) => {
    const cur = await lockOwn(tx, scope, id);
    if (!cur) return { ok: false as const, reason: "inquiry_not_found" as const };
    if (cur.status !== "WAITING") return { ok: false as const, reason: "already_answered" as const };
    if (!(await attachImages(tx, scope, id, p.v.imageIds))) return { ok: false as const, reason: "invalid_images" as const };
    await tx.buyerInquiry.update({ where: { id }, data: { title: p.v.title, body: p.v.body, isPrivate: p.v.isPrivate, updatedAt: await lockedNow(tx) } });
    await buyerAudit(tx, scope, meta, "buyer_inquiry.update", id, { isPrivate: p.v.isPrivate, titleLength: p.v.title.length, bodyLength: p.v.body.length, photos: p.v.imageIds.length });
    return { ok: true as const };
  });
}

export async function deleteInquiry(db: PrismaClient, scope: BuyerScope, id: string, meta: AuditMeta = {}) {
  if (!isUuid(id)) return { ok: false as const, reason: "inquiry_not_found" as const };
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  return db.$transaction(async (tx) => {
    const cur = await lockOwn(tx, scope, id);
    if (!cur) return { ok: false as const, reason: "inquiry_not_found" as const };
    if (cur.status !== "WAITING") return { ok: false as const, reason: "already_answered" as const };
    await tx.buyerInquiry.delete({ where: { sellerId_id: { sellerId: scope.sellerId, id } } }); // 사진은 CASCADE
    await buyerAudit(tx, scope, meta, "buyer_inquiry.delete", id);
    return { ok: true as const };
  });
}

// 탈퇴(buyers/withdraw.ts): 작성자 표시를 비식별하고 사진(붙은 것 포함)을 지운다. 글은 남긴다.
export async function anonymizeMemberInquiries(tx: Prisma.TransactionClient, scope: BuyerScope) {
  const inquiries = await tx.buyerInquiry.updateMany({ where: scope, data: { authorNickname: WITHDRAWN_DISPLAY_NAME } });
  const images = await tx.buyerInquiryImage.deleteMany({ where: scope });
  return { inquiries: inquiries.count, deletedImages: images.count };
}

// ───────── 파트너스 ─────────
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const kstStart = (v: string): Date | null => {
  if (!DATE.test(v)) return null;
  const d = new Date(`${v}T00:00:00+09:00`);
  return !Number.isNaN(d.getTime()) && new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10) === v ? d : null;
};

// 목록: ?status(WAITING|ANSWERED)·kind(PRODUCT|GENERAL)·from·to(KST 날짜, 끝 포함, 작성일 기준)·q(제목·내용·작성자·상품명)·cursor. 조회는 같은 쇼핑몰 계정 누구나.
export async function listSellerInquiries(
  db: PrismaClient,
  ctx: TenantContext,
  q: { status?: string | null; kind?: string | null; from?: string | null; to?: string | null; q?: string | null; cursor?: string | null },
  imageBase: string,
) {
  if (q.status && q.status !== "WAITING" && q.status !== "ANSWERED") return { ok: false as const, reason: "invalid_status" as const };
  if (q.kind && q.kind !== "PRODUCT" && q.kind !== "GENERAL") return { ok: false as const, reason: "invalid_status" as const };
  const from = q.from ? kstStart(q.from) : null;
  const to = q.to ? kstStart(q.to) : null;
  if ((q.from && !from) || (q.to && !to) || (from && to && from > to)) return { ok: false as const, reason: "invalid_range" as const };
  const text = (q.q ?? "").trim().slice(0, INQUIRY_SEARCH_MAX);
  const where: Prisma.BuyerInquiryWhereInput = {
    sellerId: ctx.sellerId,
    ...(q.status ? { status: q.status as "WAITING" | "ANSWERED" } : {}),
    ...(q.kind ? { kind: q.kind as "PRODUCT" | "GENERAL" } : {}),
    ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: new Date(to.getTime() + 86_400_000) } : {}) } } : {}),
    ...(text
      ? { OR: [{ title: { contains: text, mode: "insensitive" } }, { body: { contains: text, mode: "insensitive" } }, { authorNickname: { contains: text, mode: "insensitive" } }, { product: { name: { contains: text, mode: "insensitive" } } }] }
      : {}),
  };
  const at = isUuid(q.cursor) ? await db.buyerInquiry.findFirst({ where: { id: q.cursor, sellerId: ctx.sellerId }, select: { createdAt: true, id: true } }) : null;
  const [rows, waiting] = await Promise.all([
    db.buyerInquiry.findMany({ where: { AND: [where, afterCursor(at)] }, include, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: SELLER_INQUIRY_PAGE + 1 }),
    db.buyerInquiry.count({ where: { sellerId: ctx.sellerId, status: "WAITING" } }),
  ]);
  const page = rows.slice(0, SELLER_INQUIRY_PAGE);
  return {
    ok: true as const,
    value: { inquiries: page.map((r) => sellerView(r, imageBase)), nextCursor: rows.length > SELLER_INQUIRY_PAGE ? page[page.length - 1].id : null, waitingCount: waiting, canEdit: !ctx.readOnly && sellerCan(ctx, "INQUIRY_REPLY") },
  };
}

export async function getSellerInquiry(db: PrismaClient, ctx: TenantContext, id: string, imageBase: string) {
  if (!isUuid(id)) throw notFound();
  const r = await db.buyerInquiry.findFirst({ where: { id, sellerId: ctx.sellerId }, include });
  if (!r) throw notFound();
  return { inquiry: sellerView(r, imageBase), canEdit: !ctx.readOnly && sellerCan(ctx, "INQUIRY_REPLY") };
}

// 답변 쓰기·고치기·지우기. 본문 { answer: string(1000자) | null(지움) }. 대표자·INQUIRY_REPLY 직원만.
export async function answerInquiry(db: PrismaClient, ctx: TenantContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "INQUIRY_REPLY");
  if (!isUuid(id)) throw notFound();
  const v = raw && typeof raw === "object" ? (raw as { answer?: unknown }).answer : undefined;
  const answer = v === null ? null : cleanText(v, INQUIRY_ANSWER_MAX, "multiline");
  if (v === undefined || (v !== null && !answer)) return { ok: false as const, reason: "invalid_answer" as const };
  return db.$transaction(async (tx) => {
    const [row] = await tx.$queryRaw<{ answer: string | null }[]>`
      SELECT "answer" FROM "BuyerInquiry" WHERE "id" = ${id}::uuid AND "sellerId" = ${ctx.sellerId}::uuid FOR UPDATE`;
    if (!row) throw notFound();
    const now = await lockedNow(tx);
    await tx.buyerInquiry.update({
      where: { sellerId_id: { sellerId: ctx.sellerId, id } },
      data: answer ? { answer, status: "ANSWERED", answeredAt: now, answeredBySellerUserId: ctx.actorId } : { answer: null, status: "WAITING", answeredAt: null, answeredBySellerUserId: null },
    });
    // 답변 내용은 로그 추적에 남기지 않는다(길이만)
    await sellerAudit(tx, ctx, meta, answer ? (row.answer ? "buyer_inquiry.answer_update" : "buyer_inquiry.answer") : "buyer_inquiry.answer_delete", id, { answerLength: row.answer?.length ?? 0 }, { answerLength: answer?.length ?? 0 });
    return { ok: true as const };
  });
}

// ───────── 공개 상품 문의(상품 상세용, 로그인 없이) ─────────
export const PUBLIC_INQUIRY_PAGE = 20;
export const SECRET_INQUIRY_TITLE = "비밀글입니다";
// 작성자 표시: 첫 글자만 남기고 가린다(「홍***」). 탈퇴 표시는 그대로.
export const maskAuthor = (nick: string) => (nick === WITHDRAWN_DISPLAY_NAME ? nick : `${[...nick][0] ?? ""}***`);

// 그 상품의 상품 문의 목록. 비공개 글은 제목을 「비밀글입니다」로 바꾸고 내용·답변·사진은 주지 않으며 답변 여부만 보인다.
// 공개 글은 제목·내용·답변을 주고 사진은 주지 않는다(문의 사진은 작성자와 파트너스만 본다). 운영 중이 아닌 쇼핑몰·보이지 않는 상품은 null(404).
export async function publicProductInquiries(db: PrismaClient, slug: string, productId: string, cursor?: string | null) {
  const seller = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!seller || !isUuid(productId) || !(await shopOpen(db, seller.id))) return null;
  if (!(await db.product.findFirst({ where: { id: productId, sellerId: seller.id, ...SHOP_VISIBLE_PRODUCT }, select: { id: true } }))) return null;
  const base = { sellerId: seller.id, productId, kind: "PRODUCT" as const };
  const at = isUuid(cursor) ? await db.buyerInquiry.findFirst({ where: { ...base, id: cursor }, select: { createdAt: true, id: true } }) : null;
  const [total, rows] = await Promise.all([
    db.buyerInquiry.count({ where: base }),
    db.buyerInquiry.findMany({ where: { ...base, ...afterCursor(at) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: PUBLIC_INQUIRY_PAGE + 1 }),
  ]);
  const page = rows.slice(0, PUBLIC_INQUIRY_PAGE);
  return {
    total,
    inquiries: page.map((r) => ({
      id: r.id,
      isPrivate: r.isPrivate,
      author: maskAuthor(r.authorNickname),
      title: r.isPrivate ? SECRET_INQUIRY_TITLE : r.title,
      body: r.isPrivate ? null : r.body,
      answered: r.status === "ANSWERED",
      answer: r.isPrivate ? null : r.answer,
      answeredAt: r.isPrivate ? null : r.answeredAt,
      createdAt: r.createdAt,
    })),
    nextCursor: rows.length > PUBLIC_INQUIRY_PAGE ? page[page.length - 1].id : null,
  };
}
