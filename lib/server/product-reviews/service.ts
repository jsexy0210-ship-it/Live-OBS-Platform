import { Prisma, type PrismaClient, type ProductReview, type ProductReviewReason, type ProductReviewStatus } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { sellerCan } from "../authz/permissions";
import { shopOpen } from "../buyers/signup";
import { createPendingRewardLedger } from "../rewards/ledger";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { checkReviewImage, REVIEW_IMAGES_PER_REVIEW, type ReviewImageRejection } from "./image";
import {
  cleanReply,
  DEFAULT_POLICY,
  HELD_LABEL,
  heldReason,
  isReason,
  isUuid,
  parsePolicy,
  parseReview,
  REASON_BUYER,
  REVIEW_EDIT_DAYS,
  REVIEW_HIDDEN_NOTE_MAX,
  REVIEW_REPORT_HOLD,
  rewardFor,
  type PolicyInput,
  type ReviewRejection,
} from "./rules";
import { cleanText } from "../text/clean";

// 상품 리뷰(SA-048 리뷰 관리 · SH-029 리뷰 쓰기, 2026-10-04 대표님 지시, MASTER 결정 A~F).
// - 구매자: 배송 완료된 주문 상품마다 1번(쇼핑몰 설정 기간 안, 기본 30일). 7일 안에 고치고, 언제든 지울 수 있다(숨긴 리뷰는 고치지 못함). 쓰기 경로(올리기·고치기·지우기·사진·신고)는 모두 쇼핑몰 이용 가능 검사(shopOpen)를 거친다.
// - 파트너스: 조회는 누구나, 답글·숨김·공개·설정은 대표자·구매자 문의(INQUIRY_REPLY) 직원. 모든 변경은 로그 추적에 남는다.
// - 공개 방식: 바로 공개(연락처·외부 주소·금지어가 있으면 보류) 또는 확인 뒤 공개. 신고가 3건 쌓이면 공개 리뷰를 보류한다.
// - 리뷰 적립금(설정, 기본 0원): 공개될 때 지급, 숨김·삭제 때 회수(적립금 원장, 실지급 스위치가 꺼져 있으면 testMode).
// - 잠금 원칙: 리뷰를 바꾸는 쓰기는 리뷰 행 FOR UPDATE를 잡은 뒤 잠긴 값과 잠금 뒤 시각(clock_timestamp)으로 다시 검사한다.
//   새 리뷰는 회원 행 FOR SHARE(탈퇴와 겹치지 않게) 아래에서 주문 품목 자격을 보고, 주문 품목당 1개는 유니크 키가 막는다.

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };
export type BuyerScope = { sellerId: string; buyerMemberId: string };

const DAY = 86_400_000;
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

async function lockedNow(tx: Db): Promise<Date> {
  const rows = await tx.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return rows[0].now;
}

async function policyOf(db: Db, sellerId: string): Promise<PolicyInput> {
  const p = await db.productReviewPolicy.findUnique({ where: { sellerId } });
  return p ? { publishMode: p.publishMode, rewardText: p.rewardText, rewardPhoto: p.rewardPhoto, writableDays: p.writableDays, bannedWords: p.bannedWords } : DEFAULT_POLICY;
}

async function lockReview(tx: Tx, sellerId: string, id: string): Promise<ProductReview | null> {
  const [row] = await tx.$queryRaw<ProductReview[]>`SELECT * FROM "ProductReview" WHERE "id" = ${id}::uuid AND "sellerId" = ${sellerId}::uuid FOR UPDATE`;
  return row ?? null;
}

function sellerAudit(db: Db, ctx: TenantContext, meta: AuditMeta, action: string, targetId: string, before: unknown, after: unknown) {
  return writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "ProductReview", targetId, before, after, ip: meta.ip, userAgent: meta.userAgent });
}
function buyerAudit(db: Db, scope: BuyerScope, meta: AuditMeta, action: string, targetId: string | undefined, after?: unknown) {
  return writeAudit(db, { actorType: "BUYER", actorId: scope.buyerMemberId, sellerId: scope.sellerId, action, targetType: targetId ? "ProductReview" : undefined, targetId, after, ip: meta.ip, userAgent: meta.userAgent });
}

// ───────── 리뷰 적립금 ─────────
// 공개될 때 지급(이미 지급된 회차가 있으면 그대로). 다시 공개하면 새 회차로 지급한다. 리뷰 행 잠금 아래에서 부른다.
async function grantReward(tx: Tx, r: ProductReview, now: Date): Promise<number> {
  if (r.rewardedAmount > 0) return 0;
  const policy = await policyOf(tx, r.sellerId);
  const photos = await tx.productReviewImage.count({ where: { sellerId: r.sellerId, reviewId: r.id } });
  const amount = rewardFor(policy, photos);
  if (amount <= 0) return 0;
  const round = r.rewardRound + 1;
  const rp = await tx.rewardPolicy.findUnique({ where: { sellerId: r.sellerId }, select: { livePayoutEnabled: true } });
  await createPendingRewardLedger(tx, {
    sellerId: r.sellerId,
    buyerMemberId: r.buyerMemberId,
    orderId: r.orderId,
    type: "EARN",
    amount,
    testMode: !rp?.livePayoutEnabled,
    idempotencyKey: `review_reward:${r.id}:${round}`,
    createdAt: now,
  });
  await tx.productReview.update({ where: { id: r.id }, data: { rewardedAmount: amount, rewardRound: round } });
  return amount;
}

// 숨김·삭제 때 회수(지급된 금액이 있을 때만, 회차마다 한 번).
// testMode는 지금 실지급 스위치가 아니라 원래 적립 원장을 따른다(주문 환불 회수와 같은 방식). 적립 원장이 없으면 회수하지 않는다.
async function revokeReward(tx: Tx, r: ProductReview, now: Date): Promise<number> {
  if (r.rewardedAmount <= 0) return 0;
  const earn = await tx.rewardLedger.findUnique({ where: { sellerId_idempotencyKey: { sellerId: r.sellerId, idempotencyKey: `review_reward:${r.id}:${r.rewardRound}` } }, select: { testMode: true } });
  if (!earn) return 0;
  await createPendingRewardLedger(tx, {
    sellerId: r.sellerId,
    buyerMemberId: r.buyerMemberId,
    orderId: r.orderId,
    type: "REVOKE",
    amount: -r.rewardedAmount,
    testMode: earn.testMode,
    idempotencyKey: `review_revoke:${r.id}:${r.rewardRound}`,
    createdAt: now,
  });
  await tx.productReview.updateMany({ where: { id: r.id }, data: { rewardedAmount: 0 } });
  return r.rewardedAmount;
}

// ───────── 파트너스 관리자 ─────────
const sellerImageUrl = (id: string) => `/api/seller/reviews/images/${id}`;
const STATUSES: readonly ProductReviewStatus[] = ["VISIBLE", "PENDING", "HELD", "HIDDEN"];
export const SELLER_PAGE = 50;

export type SellerReviewQuery = { status?: string | null; rating?: string | null; waiting?: string | null; cursor?: string | null };

export async function listSellerReviews(db: PrismaClient, ctx: TenantContext, q: SellerReviewQuery) {
  const now = await lockedNow(db);
  const status = STATUSES.find((s) => s === q.status);
  const rating = q.rating === "low" ? { lte: 3 } : q.rating && /^[1-5]$/.test(q.rating) ? Number(q.rating) : undefined;
  let after = {};
  if (q.cursor && isUuid(q.cursor)) {
    const c = await db.productReview.findFirst({ where: { id: q.cursor, sellerId: ctx.sellerId }, select: { id: true, createdAt: true } });
    if (c) after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
  }
  const where: Prisma.ProductReviewWhereInput = {
    sellerId: ctx.sellerId,
    ...(status ? { status } : {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(q.waiting === "1" ? { reply: null, status: { not: "HIDDEN" as const } } : {}),
    ...after,
  };
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const threeDaysAgo = new Date(now.getTime() - 3 * DAY);
  const [rows, visibleAgg, dist, weekNew, photo, waiting, waitingOld, review, held, policy] = await Promise.all([
    db.productReview.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: SELLER_PAGE + 1,
      include: {
        product: { select: { name: true } },
        buyerMember: { select: { status: true, grade: { select: { displayName: true } } } },
        _count: { select: { images: true } },
      },
    }),
    db.productReview.aggregate({ where: { sellerId: ctx.sellerId, status: "VISIBLE" }, _avg: { rating: true }, _count: { _all: true } }),
    db.productReview.groupBy({ by: ["rating"], where: { sellerId: ctx.sellerId, status: "VISIBLE" }, _count: { _all: true } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, createdAt: { gte: weekAgo } } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, createdAt: { gte: weekAgo }, images: { some: {} } } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, reply: null, status: { not: "HIDDEN" } } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, reply: null, status: { not: "HIDDEN" }, createdAt: { lt: threeDaysAgo } } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, status: { in: ["PENDING", "HELD"] } } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, status: "HELD", heldBy: { in: ["contact", "url", "banned_word"] } } }),
    policyOf(db, ctx.sellerId),
  ]);
  const page = rows.slice(0, SELLER_PAGE);
  const total = visibleAgg._count._all;
  return {
    reviews: page.map((r) => ({
      id: r.id,
      productId: r.productId,
      productName: r.product.name,
      author: r.authorNickname,
      grade: r.buyerMember.status === "WITHDRAWN" ? null : r.buyerMember.grade.displayName,
      rating: r.rating,
      body: r.body,
      status: r.status,
      heldLabel: r.heldBy ? (HELD_LABEL[r.heldBy] ?? null) : null,
      hiddenReason: r.hiddenReason,
      photos: r._count.images,
      replied: r.reply !== null,
      reportCount: r.reportCount,
      createdAt: r.createdAt,
    })),
    nextCursor: rows.length > SELLER_PAGE ? page[page.length - 1].id : null,
    summary: {
      average: total > 0 ? Math.round((visibleAgg._avg.rating ?? 0) * 10) / 10 : null,
      total,
      weekNew,
      weekPhoto: photo,
      waitingReply: waiting,
      waitingOld,
      pendingOrHeld: review,
      autoHeld: held,
      distribution: [5, 4, 3, 2, 1].map((n) => ({ rating: n, count: dist.find((d) => d.rating === n)?._count._all ?? 0 })),
    },
    policy,
    canEdit: !ctx.readOnly && sellerCan(ctx, "INQUIRY_REPLY"),
  };
}

export async function getSellerReview(db: PrismaClient, ctx: TenantContext, id: string) {
  if (!isUuid(id)) throw notFound();
  const r = await db.productReview.findFirst({
    where: { id, sellerId: ctx.sellerId },
    include: {
      product: { select: { name: true } },
      orderItem: { select: { optionNameSnapshot: true, quantity: true } },
      order: { select: { orderNo: true, createdAt: true, shipment: { select: { deliveredAt: true } } } },
      images: { select: { id: true, width: true, height: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      reports: { select: { reason: true } },
    },
  });
  if (!r) throw notFound();
  const reasons: Partial<Record<ProductReviewReason, number>> = {};
  for (const x of r.reports) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
  return {
    id: r.id,
    productName: r.product.name,
    optionName: r.orderItem.optionNameSnapshot,
    quantity: r.orderItem.quantity,
    author: r.authorNickname,
    rating: r.rating,
    body: r.body,
    status: r.status,
    heldLabel: r.heldBy ? (HELD_LABEL[r.heldBy] ?? null) : null,
    hiddenReason: r.hiddenReason,
    hiddenNote: r.hiddenNote,
    reply: r.reply,
    repliedAt: r.repliedAt,
    reportCount: r.reportCount,
    reportReasons: reasons,
    rewardedAmount: r.rewardedAmount,
    images: r.images.map((i) => ({ ...i, url: sellerImageUrl(i.id) })),
    orderedAt: r.order.createdAt,
    deliveredAt: r.order.shipment?.deliveredAt ?? null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export type SellerReviewFailure = "invalid_reply" | "invalid_reason" | "invalid_note";

export async function replyReview(db: PrismaClient, ctx: TenantContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "INQUIRY_REPLY");
  if (!isUuid(id)) throw notFound();
  const v = raw && typeof raw === "object" ? (raw as { reply?: unknown }).reply : undefined;
  const reply = v === null || v === "" ? null : cleanReply(v);
  if (v !== null && v !== "" && !reply) return { ok: false as const, reason: "invalid_reply" as const };
  return db.$transaction(async (tx) => {
    const before = await lockReview(tx, ctx.sellerId, id);
    if (!before) throw notFound();
    const now = await lockedNow(tx);
    await tx.productReview.update({ where: { id }, data: { reply, repliedAt: reply ? now : null } });
    await sellerAudit(tx, ctx, meta, reply ? "review.reply" : "review.reply_delete", id, { reply: before.reply }, { reply });
    return { ok: true as const };
  });
}

export async function hideReview(db: PrismaClient, ctx: TenantContext, id: string, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "INQUIRY_REPLY");
  if (!isUuid(id)) throw notFound();
  const b = raw && typeof raw === "object" ? (raw as { reason?: unknown; note?: unknown }) : {};
  if (!isReason(b.reason)) return { ok: false as const, reason: "invalid_reason" as const };
  const note = b.note === undefined || b.note === null || b.note === "" ? null : cleanText(b.note, REVIEW_HIDDEN_NOTE_MAX, "multiline");
  if (b.note !== undefined && b.note !== null && b.note !== "" && !note) return { ok: false as const, reason: "invalid_note" as const };
  const reason = b.reason;
  return db.$transaction(async (tx) => {
    const before = await lockReview(tx, ctx.sellerId, id);
    if (!before) throw notFound();
    const now = await lockedNow(tx);
    const revoked = await revokeReward(tx, before, now);
    await tx.productReview.update({ where: { id }, data: { status: "HIDDEN", hiddenReason: reason, hiddenNote: note, heldBy: null, updatedAt: now } });
    await sellerAudit(tx, ctx, meta, "review.hide", id, { status: before.status }, { status: "HIDDEN", reason, note, revokedReward: revoked });
    return { ok: true as const, revokedReward: revoked };
  });
}

// 공개(공개 대기·보류·숨김 → 공개). 공개되면 리뷰 적립금을 지급한다(이미 지급된 회차가 있으면 그대로).
export async function publishReview(db: PrismaClient, ctx: TenantContext, id: string, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "INQUIRY_REPLY");
  if (!isUuid(id)) throw notFound();
  return db.$transaction(async (tx) => {
    const before = await lockReview(tx, ctx.sellerId, id);
    if (!before) throw notFound();
    const now = await lockedNow(tx);
    if (before.status === "VISIBLE") return { ok: true as const, grantedReward: 0 };
    await tx.productReview.update({ where: { id }, data: { status: "VISIBLE", hiddenReason: null, hiddenNote: null, heldBy: null, updatedAt: now } });
    const granted = await grantReward(tx, before, now);
    await sellerAudit(tx, ctx, meta, "review.publish", id, { status: before.status }, { status: "VISIBLE", grantedReward: granted });
    return { ok: true as const, grantedReward: granted };
  });
}

export async function getReviewPolicy(db: PrismaClient, ctx: TenantContext) {
  return { policy: await policyOf(db, ctx.sellerId), canEdit: !ctx.readOnly && sellerCan(ctx, "INQUIRY_REPLY") };
}

export async function updateReviewPolicy(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "INQUIRY_REPLY");
  const p = parsePolicy(raw);
  if (!p.ok) return p;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "Seller" WHERE "id" = ${ctx.sellerId}::uuid FOR NO KEY UPDATE`;
    const before = await policyOf(tx, ctx.sellerId);
    await tx.productReviewPolicy.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...p.v }, update: p.v });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "review.policy.update", targetType: "ProductReviewPolicy", targetId: ctx.sellerId, before, after: p.v, ip: meta.ip, userAgent: meta.userAgent });
    return { ok: true as const, policy: p.v };
  });
}

export async function sellerReviewImage(db: PrismaClient, ctx: TenantContext, imageId: string) {
  if (!isUuid(imageId)) return null;
  return db.productReviewImage.findFirst({ where: { id: imageId, sellerId: ctx.sellerId, reviewId: { not: null } }, select: { data: true, contentType: true } });
}

// ───────── 구매자 ─────────
const buyerImageUrl = (slug: string, id: string) => `/api/shop/${encodeURIComponent(slug)}/reviews/images/${id}`;

export type BuyerReviewFailure =
  | ReviewRejection
  | ReviewImageRejection
  | "shop_unavailable"
  | "not_writable" // 배송 완료 전·기간 지남·취소·환불·남의 주문
  | "already_written"
  | "not_editable" // 7일 지남·숨긴 리뷰
  | "own_review" // 내 리뷰는 신고할 수 없음
  | "already_reported"
  | "invalid_reason"
  | "too_many_images";

// 구매자 화면 문구(해요체)
export const BUYER_REVIEW_MESSAGES: Record<BuyerReviewFailure, string> = {
  invalid_rating: "별점을 골라 주세요",
  invalid_body: "리뷰를 10자 이상 1,000자 안에서 써 주세요",
  invalid_images: "사진을 다시 골라 주세요",
  empty_file: "빈 파일은 올릴 수 없어요",
  file_too_large: "사진은 1MB까지 올릴 수 있어요",
  unsupported_image: "JPEG·PNG 사진만 올릴 수 있어요",
  wrong_image_size: "사진은 긴 변 1,600px까지 올릴 수 있어요",
  png_16bit: "이 사진은 올릴 수 없어요. 다른 사진을 골라 주세요",
  png_too_large: "이 사진은 올릴 수 없어요. 다른 사진을 골라 주세요",
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없어요",
  not_writable: "리뷰를 쓸 수 있는 기간이 지났거나 쓸 수 없는 주문이에요",
  already_written: "이미 리뷰를 쓴 상품이에요",
  not_editable: "리뷰를 고칠 수 있는 기간이 지났어요",
  own_review: "내 리뷰는 신고할 수 없어요",
  already_reported: "이미 신고한 리뷰예요",
  invalid_reason: "신고 사유를 골라 주세요",
  too_many_images: "올려 두고 쓰지 않은 사진이 많아요. 리뷰를 저장한 뒤 다시 올려 주세요",
};

const UNATTACHED_KEEP = 10;

// 사진 올리기(리뷰 저장 전). 메타데이터를 지운 바이트를 저장한다. 붙지 않은 사진은 회원당 10장까지 두고 오래된 것부터 지운다.
export async function uploadReviewImage(db: PrismaClient, scope: BuyerScope, bytes: Buffer, meta: AuditMeta = {}) {
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  const c = checkReviewImage(bytes);
  if (!c.ok) return c;
  return db.$transaction(async (tx) => {
    const [member] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR UPDATE`;
    if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
    const old = await tx.productReviewImage.findMany({ where: { ...scope, reviewId: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: UNATTACHED_KEEP - 1, select: { id: true } });
    if (old.length > 0) await tx.productReviewImage.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
    const img = await tx.productReviewImage.create({
      data: { ...scope, data: new Uint8Array(c.image.data), contentType: c.image.type, byteSize: c.image.data.length, width: c.image.width, height: c.image.height },
      select: { id: true, width: true, height: true },
    });
    await buyerAudit(tx, scope, meta, "buyer_review.image_upload", undefined, { imageId: img.id, byteSize: c.image.data.length });
    return { ok: true as const, image: img };
  });
}

// 내가 볼 수 있는 사진(내가 올린 사진, 내 리뷰에 붙은 사진)
export async function buyerReviewImage(db: PrismaClient, scope: BuyerScope, imageId: string) {
  if (!isUuid(imageId)) return null;
  return db.productReviewImage.findFirst({ where: { id: imageId, sellerId: scope.sellerId, buyerMemberId: scope.buyerMemberId }, select: { data: true, contentType: true } });
}

// 공개 사진: 공개 리뷰에 붙은 사진만
export async function publicReviewImage(db: PrismaClient, sellerId: string, imageId: string) {
  if (!isUuid(imageId)) return null;
  return db.productReviewImage.findFirst({ where: { id: imageId, sellerId, review: { status: "VISIBLE" } }, select: { data: true, contentType: true } });
}

// 쓸 수 있는 주문 품목: 본인 주문, 결제 완료(취소·환불 아님), 배송 완료 뒤 설정 기간 안, 리뷰 없음
async function writableItems(db: Db, scope: BuyerScope, now: Date, writableDays: number, orderItemId?: string) {
  const since = new Date(now.getTime() - writableDays * DAY);
  return db.orderItem.findMany({
    where: {
      sellerId: scope.sellerId,
      ...(orderItemId ? { id: orderItemId } : {}),
      review: null,
      order: { buyerMemberId: scope.buyerMemberId, status: "PAID", legalHoldAt: null, shipment: { deliveredAt: { gt: since, lte: now } } },
    },
    include: { order: { select: { id: true, orderNo: true, createdAt: true, shipment: { select: { deliveredAt: true } } } }, product: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 100,
  });
}

// 내 리뷰(SH-029 「내 리뷰 목록」): 쓸 수 있는 상품과 내가 쓴 리뷰(숨김 사유·답글 포함)
export async function myReviews(db: PrismaClient, scope: BuyerScope, slug: string) {
  const now = await lockedNow(db);
  const policy = await policyOf(db, scope.sellerId);
  const [items, mine] = await Promise.all([
    writableItems(db, scope, now, policy.writableDays),
    db.productReview.findMany({
      where: scope,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 100,
      include: { product: { select: { name: true } }, orderItem: { select: { optionNameSnapshot: true } }, images: { select: { id: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    }),
  ]);
  return {
    writable: items.map((i) => ({
      orderItemId: i.id,
      productName: i.productNameSnapshot,
      optionName: i.optionNameSnapshot,
      quantity: i.quantity,
      orderedAt: i.order.createdAt,
      deliveredAt: i.order.shipment?.deliveredAt ?? null,
      writableUntil: i.order.shipment?.deliveredAt ? new Date(i.order.shipment.deliveredAt.getTime() + policy.writableDays * DAY) : null,
    })),
    reviews: mine.map((r) => ({
      id: r.id,
      productName: r.product.name,
      optionName: r.orderItem.optionNameSnapshot,
      rating: r.rating,
      body: r.body,
      status: r.status,
      hiddenReason: r.hiddenReason ? REASON_BUYER[r.hiddenReason] : null,
      hiddenNote: r.status === "HIDDEN" ? r.hiddenNote : null,
      reply: r.reply,
      repliedAt: r.repliedAt,
      rewardedAmount: r.rewardedAmount,
      images: r.images.map((i) => ({ id: i.id, url: buyerImageUrl(slug, i.id) })),
      createdAt: r.createdAt,
      editable: r.status !== "HIDDEN" && now.getTime() < r.createdAt.getTime() + REVIEW_EDIT_DAYS * DAY,
    })),
    reward: { text: policy.rewardText, photo: policy.rewardPhoto },
    writableDays: policy.writableDays,
    now,
  };
}

// 쓰기 화면용: 이 주문 품목을 지금 쓸 수 있는지(상품 이름·주문·배송 정보)
export async function writableItem(db: PrismaClient, scope: BuyerScope, orderItemId: string) {
  if (!isUuid(orderItemId)) return null;
  const now = await lockedNow(db);
  const policy = await policyOf(db, scope.sellerId);
  const [i] = await writableItems(db, scope, now, policy.writableDays, orderItemId);
  return i
    ? { orderItemId: i.id, productName: i.productNameSnapshot, optionName: i.optionNameSnapshot, quantity: i.quantity, orderedAt: i.order.createdAt, deliveredAt: i.order.shipment?.deliveredAt ?? null, reward: { text: policy.rewardText, photo: policy.rewardPhoto } }
    : null;
}

type Result<T> = { ok: true } & T | { ok: false; reason: BuyerReviewFailure };

// 사진을 리뷰에 붙인다(내가 올렸고 아직 붙지 않은 사진만). 순서는 고른 순서.
// 조건부 선점: 한 번의 UPDATE로 「아직 안 붙었거나 이 리뷰에 붙은 내 사진」만 가져오고, 바뀐 행 수가 요청 수와 다르면 거절(트랜잭션 롤백).
// 같은 사진으로 두 리뷰를 동시에 쓰면 뒤 UPDATE는 앞 트랜잭션의 행 잠금을 기다렸다가 조건을 다시 보아 빠지므로, 사진 리뷰 적립이 두 번 나가지 않는다.
async function attachImages(tx: Tx, scope: BuyerScope, reviewId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const { count } = await tx.productReviewImage.updateMany({ where: { ...scope, id: { in: ids }, OR: [{ reviewId: null }, { reviewId }] }, data: { reviewId } });
  if (count !== ids.length) return false;
  for (const [i, id] of ids.entries()) await tx.productReviewImage.update({ where: { id }, data: { reviewId, sortOrder: i } });
  return true;
}

// 새 리뷰의 상태: 확인 뒤 공개면 공개 대기, 아니면 자동 검사에 걸리면 보류, 그 밖은 공개
function initialStatus(policy: PolicyInput, body: string): { status: ProductReviewStatus; heldBy: string | null } {
  const held = heldReason(body, policy.bannedWords);
  if (held) return { status: "HELD", heldBy: held };
  return policy.publishMode === "REVIEW" ? { status: "PENDING", heldBy: null } : { status: "VISIBLE", heldBy: null };
}

export async function createReview(db: PrismaClient, scope: BuyerScope, orderItemId: unknown, raw: unknown, meta: AuditMeta = {}): Promise<Result<{ reviewId: string; status: ProductReviewStatus; grantedReward: number }>> {
  if (!isUuid(orderItemId)) return { ok: false, reason: "not_writable" };
  const p = parseReview(raw, REVIEW_IMAGES_PER_REVIEW);
  if (!p.ok) return p;
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false, reason: "shop_unavailable" };
  try {
    return await db.$transaction(async (tx) => {
      const [member] = await tx.$queryRaw<{ id: string; broadcastNickname: string }[]>`
        SELECT "id", "broadcastNickname" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
      if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
      const now = await lockedNow(tx);
      const policy = await policyOf(tx, scope.sellerId);
      const [item] = await writableItems(tx, scope, now, policy.writableDays, orderItemId);
      if (!item) {
        const exists = await tx.productReview.count({ where: { sellerId: scope.sellerId, orderItemId } });
        return { ok: false as const, reason: exists ? ("already_written" as const) : ("not_writable" as const) };
      }
      const st = initialStatus(policy, p.v.body);
      const review = await tx.productReview.create({
        data: {
          sellerId: scope.sellerId,
          orderId: item.orderId,
          orderItemId: item.id,
          productId: item.productId,
          buyerMemberId: member.id,
          authorNickname: member.broadcastNickname,
          rating: p.v.rating,
          body: p.v.body,
          status: st.status,
          heldBy: st.heldBy,
          createdAt: now,
          updatedAt: now,
        },
      });
      if (!(await attachImages(tx, scope, review.id, p.v.imageIds))) throw new BadImages();
      const granted = st.status === "VISIBLE" ? await grantReward(tx, review, now) : 0;
      await buyerAudit(tx, scope, meta, "buyer_review.create", review.id, { status: st.status, rating: p.v.rating, photos: p.v.imageIds.length, grantedReward: granted });
      return { ok: true as const, reviewId: review.id, status: st.status, grantedReward: granted };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "already_written" };
    if (e instanceof BadImages) return { ok: false, reason: "invalid_images" };
    throw e;
  }
}

class BadImages extends Error {}

// 고치기(쓴 뒤 7일 안, 숨긴 리뷰는 안 됨). 답글은 그대로 둔다. 다시 자동 검사해 걸리면 보류, 보류였는데 깨끗해지면 처음 상태 규칙대로.
export async function updateReview(db: PrismaClient, scope: BuyerScope, id: string, raw: unknown, meta: AuditMeta = {}): Promise<Result<{ status: ProductReviewStatus }>> {
  if (!isUuid(id)) throw notFound();
  const p = parseReview(raw, REVIEW_IMAGES_PER_REVIEW);
  if (!p.ok) return p;
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false, reason: "shop_unavailable" };
  try {
    return await db.$transaction(async (tx) => {
      const before = await lockReview(tx, scope.sellerId, id);
      if (!before || before.buyerMemberId !== scope.buyerMemberId) throw notFound();
      const now = await lockedNow(tx);
      if (before.status === "HIDDEN" || now.getTime() >= before.createdAt.getTime() + REVIEW_EDIT_DAYS * DAY) return { ok: false as const, reason: "not_editable" as const };
      const policy = await policyOf(tx, scope.sellerId);
      const held = heldReason(p.v.body, policy.bannedWords);
      // 신고 누적 보류·공개 대기는 판매자가 풀 때까지 그대로 둔다
      const status: ProductReviewStatus = held
        ? "HELD"
        : before.status === "HELD" && before.heldBy !== "reports"
          ? policy.publishMode === "REVIEW"
            ? "PENDING"
            : "VISIBLE"
          : before.status;
      const heldBy = held ?? (status === "HELD" ? before.heldBy : null);
      await tx.productReviewImage.updateMany({ where: { sellerId: scope.sellerId, reviewId: id, id: { notIn: p.v.imageIds } }, data: { reviewId: null } });
      if (!(await attachImages(tx, scope, id, p.v.imageIds))) throw new BadImages();
      await tx.productReview.update({ where: { id }, data: { rating: p.v.rating, body: p.v.body, status, heldBy, updatedAt: now } });
      // 보류에서 공개로 바뀌면 적립금을 지급한다(이미 지급했으면 그대로)
      if (status === "VISIBLE" && before.status !== "VISIBLE") await grantReward(tx, { ...before, status }, now);
      await buyerAudit(tx, scope, meta, "buyer_review.update", id, { status, rating: p.v.rating, photos: p.v.imageIds.length });
      return { ok: true as const, status };
    });
  } catch (e) {
    if (e instanceof BadImages) return { ok: false, reason: "invalid_images" };
    throw e;
  }
}

// 지우기(작성자만, 언제든, 쇼핑몰 이용이 막히면 안 됨). 지급한 리뷰 적립금은 회수한다. 사진·신고는 함께 지운다.
export async function deleteReview(db: PrismaClient, scope: BuyerScope, id: string, meta: AuditMeta = {}): Promise<Result<{ revokedReward: number }>> {
  if (!isUuid(id)) throw notFound();
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false, reason: "shop_unavailable" };
  return db.$transaction(async (tx) => {
    const before = await lockReview(tx, scope.sellerId, id);
    if (!before || before.buyerMemberId !== scope.buyerMemberId) throw notFound();
    const now = await lockedNow(tx);
    const revoked = await revokeReward(tx, before, now);
    await tx.productReview.delete({ where: { id } });
    await buyerAudit(tx, scope, meta, "buyer_review.delete", id, { status: before.status, revokedReward: revoked });
    return { ok: true as const, revokedReward: revoked };
  });
}

// 신고(공개 리뷰, 1인 1번, 내 리뷰 제외). 3건이 쌓이면 보류한다.
export async function reportReview(db: PrismaClient, scope: BuyerScope, id: string, rawReason: unknown, meta: AuditMeta = {}): Promise<Result<{ held: boolean }>> {
  if (!isUuid(id)) throw notFound();
  if (!isReason(rawReason)) return { ok: false, reason: "invalid_reason" };
  const reason = rawReason;
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false, reason: "shop_unavailable" };
  try {
    return await db.$transaction(async (tx) => {
      const before = await lockReview(tx, scope.sellerId, id);
      if (!before || before.status !== "VISIBLE") throw notFound();
      if (before.buyerMemberId === scope.buyerMemberId) return { ok: false as const, reason: "own_review" as const };
      const [member] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
      if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
      await tx.productReviewReport.create({ data: { sellerId: scope.sellerId, reviewId: id, buyerMemberId: member.id, reason } });
      const count = before.reportCount + 1;
      const held = count >= REVIEW_REPORT_HOLD;
      await tx.productReview.update({ where: { id }, data: { reportCount: count, ...(held ? { status: "HELD", heldBy: "reports" } : {}) } });
      await buyerAudit(tx, scope, meta, "buyer_review.report", id, { reason, held });
      return { ok: true as const, held };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "already_reported" };
    throw e;
  }
}

// 상품의 공개 리뷰(상품 상세에 끼울 목록): 평균·분포와 최근 순 목록. 운영 중이 아닌 쇼핑몰은 null.
export const PUBLIC_PAGE = 20;
export async function productReviews(db: PrismaClient, slug: string, productId: string, cursor?: string | null) {
  const seller = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!seller || !isUuid(productId) || !(await shopOpen(db, seller.id))) return null;
  const product = await db.product.findFirst({ where: { id: productId, sellerId: seller.id, deletedAt: null }, select: { id: true } });
  if (!product) return null;
  const base = { sellerId: seller.id, productId, status: "VISIBLE" as const };
  let after = {};
  if (cursor && isUuid(cursor)) {
    const c = await db.productReview.findFirst({ where: { ...base, id: cursor }, select: { id: true, createdAt: true } });
    if (c) after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
  }
  const [agg, dist, rows] = await Promise.all([
    db.productReview.aggregate({ where: base, _avg: { rating: true }, _count: { _all: true } }),
    db.productReview.groupBy({ by: ["rating"], where: base, _count: { _all: true } }),
    db.productReview.findMany({
      where: { ...base, ...after },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: PUBLIC_PAGE + 1,
      include: { orderItem: { select: { optionNameSnapshot: true } }, images: { select: { id: true, width: true, height: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    }),
  ]);
  const page = rows.slice(0, PUBLIC_PAGE);
  return {
    average: agg._count._all > 0 ? Math.round((agg._avg.rating ?? 0) * 10) / 10 : null,
    total: agg._count._all,
    distribution: [5, 4, 3, 2, 1].map((n) => ({ rating: n, count: dist.find((d) => d.rating === n)?._count._all ?? 0 })),
    reviews: page.map((r) => ({
      id: r.id,
      author: r.authorNickname,
      rating: r.rating,
      body: r.body,
      optionName: r.orderItem.optionNameSnapshot,
      images: r.images.map((i) => ({ ...i, url: `/api/shop/${encodeURIComponent(slug)}/reviews/public-images/${i.id}` })),
      reply: r.reply,
      repliedAt: r.repliedAt,
      createdAt: r.createdAt,
    })),
    nextCursor: rows.length > PUBLIC_PAGE ? page[page.length - 1].id : null,
  };
}

// 탈퇴: 리뷰는 남기고 작성자 표시를 「탈퇴 회원」으로, 신고·붙지 않은 사진은 지운다(buyers/withdraw.ts)
export const WITHDRAWN_AUTHOR = "탈퇴 회원";
export async function anonymizeMemberReviews(tx: Tx, scope: BuyerScope) {
  const reviews = await tx.productReview.updateMany({ where: scope, data: { authorNickname: WITHDRAWN_AUTHOR } });
  const reports = await tx.productReviewReport.deleteMany({ where: scope });
  const images = await tx.productReviewImage.deleteMany({ where: { ...scope, reviewId: null } });
  return { reviews: reviews.count, reports: reports.count, images: images.count };
}

// 파트너스 관리자 문구(합니다체)
export const SELLER_REVIEW_MESSAGES: Record<SellerReviewFailure | "invalid_policy", string> = {
  invalid_reply: "답글은 1~300자로 입력해 주십시오.",
  invalid_reason: "숨김 사유를 골라 주십시오.",
  invalid_note: "사유 설명은 200자까지 입력할 수 있습니다.",
  invalid_policy: "리뷰 설정 값을 다시 확인해 주십시오. 적립금은 0~100,000원, 작성 기간은 1~365일, 금지어는 20자 이하 50개까지입니다.",
};
