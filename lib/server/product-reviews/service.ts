import { Prisma, type PrismaClient, type ProductReview, type ProductReviewReason, type ProductReviewStatus } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { sellerCan } from "../authz/permissions";
import { shopOpen } from "../buyers/signup";
import { createPendingRewardLedger } from "../rewards/ledger";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { checkReviewImage, REVIEW_IMAGES_PER_REVIEW, type ReviewImageRejection } from "./image";
import { reviewImageStore } from "./store";
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
// - 리뷰 적립금(설정, 기본 0원): 모든 상태 전이의 끝에서 settleReward 하나로 원하는 상태(공개·회원 유효·주문 결제 완료면 사진 자격 금액, 아니면 0)와 원장을 맞춘다
//   (실지급 스위치가 꺼져 있으면 testMode). 지운 리뷰는 묘비(deletedAt)로 남아 같은 주문 상품에 다시 쓸 수 없다.
// - 잠금 순서(모든 쓰기 경로가 따른다, shop-coupons와 같은 원칙): 주문 행(FOR SHARE) → 회원 행(FOR SHARE) → 리뷰 행(FOR UPDATE) → 원장.
//   · 환불은 주문 행을 바꾸고(NO KEY UPDATE), 탈퇴는 회원 행(NO KEY UPDATE) → 그 회원의 리뷰 행 순서라 같은 방향이다. 공유 잠금끼리는 서로 막지 않는다.
//   · 새 리뷰는 주문 → 회원을 잠근 뒤 주문 품목 자격(결제 완료·배송 완료·기간)을 다시 보고, 주문 품목당 1개는 유니크 키가 막는다.
//   · 기존 리뷰는 lockReviewChain으로 주문 → 작성자 회원 → 리뷰를 잠근다. 신고는 신고한 회원 → 리뷰 순서다(주문·적립을 건드리지 않음).
//   · 잠근 뒤에는 잠긴 행과 잠금 뒤 시각(clock_timestamp)으로 모든 조건을 다시 본다. 적립은 잠긴 주문이 결제 완료(PAID)일 때만 지급한다.

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

// 판매자가 아직 확인하지 않은 신고 수(판매자가 공개하면 그때까지의 신고에 resolvedAt을 남긴다)
// (판매자가 확인했거나 신고자가 철회한 신고는 세지 않는다)
const openReportCount = (db: Db, sellerId: string, reviewId: string) => db.productReviewReport.count({ where: { sellerId, reviewId, resolvedAt: null, withdrawnAt: null } });

// 주문 행 공유 잠금. 결제 완료(PAID)인지 돌려준다(잠근 뒤의 상태).
async function lockOrderPaid(tx: Tx, sellerId: string, orderId: string): Promise<boolean> {
  const [o] = await tx.$queryRaw<{ status: string }[]>`SELECT "status"::text AS "status" FROM "Order" WHERE "id" = ${orderId}::uuid AND "sellerId" = ${sellerId}::uuid FOR SHARE`;
  return o?.status === "PAID";
}

// 기존 리뷰를 바꾸는 쓰기의 잠금: 주문(FOR SHARE) → 작성자 회원(FOR SHARE) → 리뷰(FOR UPDATE). 주문·작성자는 리뷰에서 바뀌지 않는 값이다.
// 신고처럼 다른 회원(신고한 회원)도 함께 잠가야 하면 extraMemberId로 넘긴다(회원 잠금끼리는 id 순서). 지운 리뷰(묘비)는 없는 것으로 본다.
async function lockReviewChain(tx: Tx, sellerId: string, id: string, extraMemberId?: string): Promise<{ review: ProductReview; orderPaid: boolean } | null> {
  const ref = await tx.productReview.findFirst({ where: { id, sellerId, deletedAt: null }, select: { orderId: true, buyerMemberId: true } });
  if (!ref) return null;
  const orderPaid = await lockOrderPaid(tx, sellerId, ref.orderId);
  for (const memberId of [...new Set([ref.buyerMemberId, ...(extraMemberId ? [extraMemberId] : [])])].sort())
    await tx.$queryRaw`SELECT "id" FROM "BuyerMember" WHERE "id" = ${memberId}::uuid AND "sellerId" = ${sellerId}::uuid FOR SHARE`;
  const review = await lockReview(tx, sellerId, id);
  return review && !review.deletedAt ? { review, orderPaid } : null;
}

function sellerAudit(db: Db, ctx: TenantContext, meta: AuditMeta, action: string, targetId: string, before: unknown, after: unknown) {
  return writeAudit(db, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "ProductReview", targetId, before, after, ip: meta.ip, userAgent: meta.userAgent });
}
function buyerAudit(db: Db, scope: BuyerScope, meta: AuditMeta, action: string, targetId: string | undefined, after?: unknown) {
  return writeAudit(db, { actorType: "BUYER", actorId: scope.buyerMemberId, sellerId: scope.sellerId, action, targetType: targetId ? "ProductReview" : undefined, targetId, after, ip: meta.ip, userAgent: meta.userAgent });
}

// ───────── 리뷰 적립금 ─────────
// 리뷰의 적립 금액은 리뷰에 저장하지 않고 원장에서 계산한다(원장과 어긋날 수 없게).
// 지금 회차(rewardRound)의 적립 원장이 있고 실패(탈퇴 등)가 아니며 같은 회차 회수 원장이 없을 때만 그 금액이 유효하다.
type RewardRef = { id: string; rewardRound: number };
export async function activeRewards(db: Db, sellerId: string, reviews: RewardRef[]): Promise<Map<string, { amount: number; testMode: boolean }>> {
  const live = reviews.filter((r) => r.rewardRound > 0);
  const out = new Map<string, { amount: number; testMode: boolean }>();
  if (live.length === 0) return out;
  const keys = live.flatMap((r) => [`review_reward:${r.id}:${r.rewardRound}`, `review_revoke:${r.id}:${r.rewardRound}`]);
  const rows = await db.rewardLedger.findMany({ where: { sellerId, idempotencyKey: { in: keys } }, select: { idempotencyKey: true, amount: true, status: true, testMode: true } });
  const by = new Map(rows.map((x) => [x.idempotencyKey, x]));
  for (const r of live) {
    const earn = by.get(`review_reward:${r.id}:${r.rewardRound}`);
    if (earn && earn.status !== "FAILED" && !by.has(`review_revoke:${r.id}:${r.rewardRound}`)) out.set(r.id, { amount: earn.amount, testMode: earn.testMode });
  }
  return out;
}

// 리뷰 적립은 이 함수 하나로만 바꾼다(멱등, 모든 상태 전이의 끝에서 부른다). 리뷰 행 잠금 아래에서 부르고, r은 바뀐 뒤의 값이다.
// 원하는 금액 = 리뷰가 공개(VISIBLE)이고 지우지 않았고, 작성 회원이 ACTIVE이고, 잠긴 주문이 결제 완료(PAID)이면 지금 사진 자격의 금액, 아니면 0.
//   지금 유효한 지급이 같은 사진 자격(rewardForPhoto)으로 나간 것이면 그 지급 금액(원장)을 그대로 원하는 금액으로 본다. 설정을 바꾼 뒤
//   별점·본문만 고쳐도 이미 준 적립금을 다시 계산하지 않는다(Codex 4177188513). 자격이 바뀌거나 새로 지급할 때만 지금 설정 금액을 쓴다.
// 지금 유효한 원장 금액(activeRewards)과 다르면 이번 회차를 회수하고(회수 testMode는 원래 적립 원장을 따른다) 원하는 금액이 있으면 새 회차로 지급한다.
// 결과는 돌려받은 원장 상태로 판단한다(실패한 적립·회수는 0으로 센다). 같은 상태로 다시 불러도 원장은 바뀌지 않는다.
export type Settled = { granted: number; revoked: number };
async function settleReward(tx: Tx, r: ProductReview, now: Date, orderPaid: boolean): Promise<Settled> {
  const active = (await activeRewards(tx, r.sellerId, [r])).get(r.id);
  let want = 0;
  if (r.status === "VISIBLE" && !r.deletedAt && !orderPaid && active) {
    // 환불된 주문의 적립 회수는 주문 적립과 같은 회수 방식을 따른다. MANUAL이면 판매자의 수동 확인 대상으로 남기고,
    // 그 뒤의 고치기 등 다른 전이가 자동으로 회수하지 않는다(Codex 4177247985). 숨김·삭제·탈퇴처럼 리뷰 쪽 사유가 있으면 그 사유로 회수한다.
    const rp = await tx.rewardPolicy.findUnique({ where: { sellerId: r.sellerId }, select: { revokeMode: true } });
    const m = await tx.buyerMember.findUnique({ where: { id: r.buyerMemberId }, select: { status: true, deletedAt: true } });
    if (rp?.revokeMode === "MANUAL" && m?.status === "ACTIVE" && !m.deletedAt) return { granted: 0, revoked: 0 };
  }
  if (r.status === "VISIBLE" && !r.deletedAt && orderPaid) {
    const m = await tx.buyerMember.findUnique({ where: { id: r.buyerMemberId }, select: { status: true, deletedAt: true } });
    if (m?.status === "ACTIVE" && !m.deletedAt) {
      const photos = await tx.productReviewImage.count({ where: { sellerId: r.sellerId, reviewId: r.id } });
      want = active && r.rewardForPhoto === photos > 0 ? active.amount : rewardFor(await policyOf(tx, r.sellerId), photos);
    }
  }
  const out: Settled = { granted: 0, revoked: 0 };
  if ((active?.amount ?? 0) === want) return out;
  const base = { sellerId: r.sellerId, buyerMemberId: r.buyerMemberId, orderId: r.orderId, createdAt: now };
  if (active) {
    const revoke = await createPendingRewardLedger(tx, { ...base, type: "REVOKE", amount: -active.amount, testMode: active.testMode, idempotencyKey: `review_revoke:${r.id}:${r.rewardRound}` });
    out.revoked = revoke.status === "FAILED" ? 0 : active.amount;
  }
  if (want > 0) {
    const round = r.rewardRound + 1;
    const forPhoto = (await tx.productReviewImage.count({ where: { sellerId: r.sellerId, reviewId: r.id } })) > 0;
    const rp = await tx.rewardPolicy.findUnique({ where: { sellerId: r.sellerId }, select: { livePayoutEnabled: true } });
    const earn = await createPendingRewardLedger(tx, { ...base, type: "EARN", amount: want, testMode: !rp?.livePayoutEnabled, idempotencyKey: `review_reward:${r.id}:${round}` });
    await tx.productReview.update({ where: { id: r.id }, data: { rewardRound: round, rewardForPhoto: forPhoto } });
    out.granted = earn.status === "FAILED" ? 0 : want;
  }
  return out;
}

// 환불(queue/service.ts refundOrder)에서 부른다. 주문 행은 환불이 이미 잠갔다(NO KEY UPDATE). 그 뒤 회원 → 리뷰 → 원장 순서로
// 이 주문 리뷰의 적립을 settleReward로 맞춘다(환불된 주문이라 원하는 금액은 0). 회수 방식은 주문 적립과 같다:
// AUTO(기본)면 회수, MANUAL이면 주문 적립처럼 기록하지 않고 수동 확인 대상으로 둔다.
export type ReviewRewardRevoke = { outcome: "revoked" | "manual_review" | "none"; amount: number };
export async function revokeReviewRewardsForOrder(tx: Tx, sellerId: string, orderId: string, now: Date): Promise<ReviewRewardRevoke> {
  const policy = await tx.rewardPolicy.findUnique({ where: { sellerId }, select: { revokeMode: true } });
  const refs = await tx.productReview.findMany({ where: { sellerId, orderId }, select: { id: true, buyerMemberId: true, rewardRound: true }, orderBy: { id: "asc" } });
  const active = await activeRewards(tx, sellerId, refs);
  if (active.size === 0) return { outcome: "none", amount: 0 };
  const total = [...active.values()].reduce((a, x) => a + x.amount, 0);
  // MANUAL: 주문 적립처럼 기록하지 않고, 회수할 리뷰 적립을 환불 결과·로그 추적에 드러내 판매자가 수동으로 확인하게 한다
  if (policy?.revokeMode === "MANUAL") return { outcome: "manual_review", amount: total };
  let revoked = 0;
  for (const ref of refs.filter((r) => active.has(r.id))) {
    await tx.$queryRaw`SELECT "id" FROM "BuyerMember" WHERE "id" = ${ref.buyerMemberId}::uuid AND "sellerId" = ${sellerId}::uuid FOR SHARE`;
    const r = await lockReview(tx, sellerId, ref.id);
    if (r) revoked += (await settleReward(tx, r, now, false)).revoked;
  }
  return { outcome: "revoked", amount: revoked };
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
    sellerId: ctx.sellerId, deletedAt: null,
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
        order: { select: { status: true } },
        _count: { select: { images: true, reports: { where: { resolvedAt: null, withdrawnAt: null } } } },
      },
    }),
    db.productReview.aggregate({ where: { sellerId: ctx.sellerId, deletedAt: null, status: "VISIBLE" }, _avg: { rating: true }, _count: { _all: true } }),
    db.productReview.groupBy({ by: ["rating"], where: { sellerId: ctx.sellerId, deletedAt: null, status: "VISIBLE" }, _count: { _all: true } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, deletedAt: null, createdAt: { gte: weekAgo } } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, deletedAt: null, createdAt: { gte: weekAgo }, images: { some: {} } } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, deletedAt: null, reply: null, status: { not: "HIDDEN" } } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, deletedAt: null, reply: null, status: { not: "HIDDEN" }, createdAt: { lt: threeDaysAgo } } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, deletedAt: null, status: { in: ["PENDING", "HELD"] } } }),
    db.productReview.count({ where: { sellerId: ctx.sellerId, deletedAt: null, status: "HELD", heldBy: { in: ["contact", "url", "banned_word", "reports"] } } }),
    policyOf(db, ctx.sellerId),
  ]);
  const page = rows.slice(0, SELLER_PAGE);
  const rewards = await activeRewards(db, ctx.sellerId, page);
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
      rewardedAmount: rewards.get(r.id)?.amount ?? 0,
      // 환불된 주문인데 리뷰 적립이 남아 있으면(회수 방식 MANUAL) 판매자가 수동으로 회수해야 한다
      revokePending: r.order.status !== "PAID" ? (rewards.get(r.id)?.amount ?? 0) : 0,
      replied: r.reply !== null,
      reportCount: r._count.reports,
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
    where: { id, sellerId: ctx.sellerId, deletedAt: null },
    include: {
      product: { select: { name: true } },
      orderItem: { select: { optionNameSnapshot: true, quantity: true } },
      order: { select: { orderNo: true, status: true, createdAt: true, shipment: { select: { deliveredAt: true } } } },
      images: { select: { id: true, width: true, height: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
      reports: { where: { resolvedAt: null, withdrawnAt: null }, select: { reason: true } },
    },
  });
  if (!r) throw notFound();
  const reasons: Partial<Record<ProductReviewReason, number>> = {};
  for (const x of r.reports) reasons[x.reason] = (reasons[x.reason] ?? 0) + 1;
  const reward = (await activeRewards(db, ctx.sellerId, [r])).get(r.id)?.amount ?? 0;
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
    reportCount: r.reports.length,
    reportReasons: reasons,
    rewardedAmount: reward,
    revokePending: r.order.status !== "PAID" ? reward : 0,
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
    const locked = await lockReviewChain(tx, ctx.sellerId, id);
    if (!locked) throw notFound();
    const before = locked.review;
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
    const locked = await lockReviewChain(tx, ctx.sellerId, id);
    if (!locked) throw notFound();
    const before = locked.review;
    const now = await lockedNow(tx);
    await tx.productReview.update({ where: { id }, data: { status: "HIDDEN", hiddenReason: reason, hiddenNote: note, heldBy: null, updatedAt: now } });
    const { revoked } = await settleReward(tx, { ...before, status: "HIDDEN" }, now, locked.orderPaid);
    await sellerAudit(tx, ctx, meta, "review.hide", id, { status: before.status }, { status: "HIDDEN", reason, note, revokedReward: revoked });
    return { ok: true as const, revokedReward: revoked };
  });
}

// 공개(공개 대기·보류·숨김 → 공개). 적립은 settleReward로 원하는 상태에 맞춘다(신고 보류 해제 포함).
export async function publishReview(db: PrismaClient, ctx: TenantContext, id: string, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "INQUIRY_REPLY");
  if (!isUuid(id)) throw notFound();
  return db.$transaction(async (tx) => {
    const locked = await lockReviewChain(tx, ctx.sellerId, id);
    if (!locked) throw notFound();
    const before = locked.review;
    const now = await lockedNow(tx);
    if (before.status === "VISIBLE") return { ok: true as const, grantedReward: 0 };
    // 판매자가 확인해 공개하면 그때까지의 신고에 resolvedAt을 남긴다(신고 기록은 남고, 현재 신고 수·사유 집계에서 빠진다)
    await tx.productReview.update({ where: { id }, data: { status: "VISIBLE", hiddenReason: null, hiddenNote: null, heldBy: null, updatedAt: now } });
    await tx.productReviewReport.updateMany({ where: { sellerId: ctx.sellerId, reviewId: id, resolvedAt: null }, data: { resolvedAt: now } });
    const { granted } = await settleReward(tx, { ...before, status: "VISIBLE" }, now, locked.orderPaid);
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
  return reviewImageStore.get(db, { id: imageId, sellerId: ctx.sellerId, reviewId: { not: null } });
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
    if (old.length > 0) await reviewImageStore.delete(tx, { id: { in: old.map((o) => o.id) } });
    const img = await reviewImageStore.put(tx, { ...scope, image: c.image });
    await buyerAudit(tx, scope, meta, "buyer_review.image_upload", undefined, { imageId: img.id, byteSize: c.image.data.length });
    return { ok: true as const, image: img };
  });
}

// 내가 볼 수 있는 사진(내가 올린 사진, 내 리뷰에 붙은 사진)
export async function buyerReviewImage(db: PrismaClient, scope: BuyerScope, imageId: string) {
  if (!isUuid(imageId)) return null;
  return reviewImageStore.get(db, { id: imageId, sellerId: scope.sellerId, buyerMemberId: scope.buyerMemberId });
}

// 공개 범위: 매장에 보이는 상품(판매 중·품절, 지우지 않음)의 공개 리뷰만. 공개 목록과 공개 사진이 같은 조건을 쓴다(shop/sharePreview.ts와 같은 조건).
export const SHOP_VISIBLE_PRODUCT = { deletedAt: null, status: { in: ["ON_SALE", "SOLD_OUT"] } } satisfies Prisma.ProductWhereInput;

// 공개 사진: 매장에 보이는 상품의 공개 리뷰에 붙은 사진만
export async function publicReviewImage(db: PrismaClient, sellerId: string, imageId: string) {
  if (!isUuid(imageId)) return null;
  return reviewImageStore.get(db, { id: imageId, sellerId, review: { status: "VISIBLE", deletedAt: null, product: SHOP_VISIBLE_PRODUCT } });
}

// 쓸 수 있는 주문 품목: 본인 주문, 결제 완료(취소·환불 아님), 배송 완료 뒤 설정 기간 안, 리뷰 없음(지운 리뷰의 묘비가 있으면 작성 완료로 본다)
// 목록은 (createdAt, id) 커서로 MY_PAGE개씩 준다.
export const MY_PAGE = 50;
type Cursor = { createdAt: Date; id: string } | null;
const afterCursor = (c: Cursor) => (c ? { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] } : {});
async function writableItems(db: Db, scope: BuyerScope, now: Date, writableDays: number, opts: { orderItemId?: string; after?: Cursor } = {}) {
  const since = new Date(now.getTime() - writableDays * DAY);
  return db.orderItem.findMany({
    where: {
      sellerId: scope.sellerId,
      ...(opts.orderItemId ? { id: opts.orderItemId } : {}),
      ...afterCursor(opts.after ?? null),
      review: null,
      order: { buyerMemberId: scope.buyerMemberId, status: "PAID", legalHoldAt: null, shipment: { deliveredAt: { gt: since, lte: now } } },
    },
    include: { order: { select: { id: true, orderNo: true, createdAt: true, shipment: { select: { deliveredAt: true } } } }, product: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: MY_PAGE + 1,
  });
}

// 내 리뷰(SH-029 「내 리뷰 목록」): 쓸 수 있는 상품과 내가 쓴 리뷰(숨김 사유·답글 포함)
// 내 리뷰 한 건의 화면 값(목록·단건 조회가 같이 쓴다). 고칠 수 있는지(숨기지 않았고 쓴 뒤 7일 안)는 서버가 정한다.
const MY_INCLUDE = { product: { select: { name: true } }, orderItem: { select: { optionNameSnapshot: true } }, images: { select: { id: true }, orderBy: [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }] } } satisfies Prisma.ProductReviewInclude;
type MyRow = Prisma.ProductReviewGetPayload<{ include: typeof MY_INCLUDE }>;
function myView(r: MyRow, slug: string, now: Date, reward: number) {
  return {
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
    rewardedAmount: reward,
    images: r.images.map((i) => ({ id: i.id, url: buyerImageUrl(slug, i.id) })),
    createdAt: r.createdAt,
    editable: r.status !== "HIDDEN" && now.getTime() < r.createdAt.getTime() + REVIEW_EDIT_DAYS * DAY,
  };
}

// 내 리뷰 단건(고치기 화면). 목록에서 찾지 않고 id로 직접 읽는다. 본인·지우지 않은 리뷰만, 아니면 null(404).
export async function myReview(db: PrismaClient, scope: BuyerScope, slug: string, id: string) {
  if (!isUuid(id)) return null;
  const r = await db.productReview.findFirst({ where: { ...scope, id, deletedAt: null }, include: MY_INCLUDE });
  if (!r) return null;
  const now = await lockedNow(db);
  return myView(r, slug, now, (await activeRewards(db, scope.sellerId, [r])).get(r.id)?.amount ?? 0);
}

// cursor: 내가 쓴 리뷰 다음 쪽, writableCursor: 리뷰를 기다리는 상품 다음 쪽(각각 nextCursor·writableNextCursor로 받은 id).
export async function myReviews(db: PrismaClient, scope: BuyerScope, slug: string, q: { cursor?: string | null; writableCursor?: string | null } = {}) {
  const now = await lockedNow(db);
  const policy = await policyOf(db, scope.sellerId);
  const reviewAfter = isUuid(q.cursor) ? await db.productReview.findFirst({ where: { ...scope, id: q.cursor }, select: { id: true, createdAt: true } }) : null;
  const itemAfter = isUuid(q.writableCursor) ? await db.orderItem.findFirst({ where: { sellerId: scope.sellerId, id: q.writableCursor }, select: { id: true, createdAt: true } }) : null;
  const [itemRows, mineRows] = await Promise.all([
    writableItems(db, scope, now, policy.writableDays, { after: itemAfter }),
    db.productReview.findMany({
      where: { ...scope, deletedAt: null, ...afterCursor(reviewAfter) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MY_PAGE + 1,
      include: MY_INCLUDE,
    }),
  ]);
  const items = itemRows.slice(0, MY_PAGE);
  const mine = mineRows.slice(0, MY_PAGE);
  const rewards = await activeRewards(db, scope.sellerId, mine);
  return {
    writableNextCursor: itemRows.length > MY_PAGE ? items[items.length - 1].id : null,
    nextCursor: mineRows.length > MY_PAGE ? mine[mine.length - 1].id : null,
    writable: items.map((i) => ({
      orderItemId: i.id,
      productName: i.productNameSnapshot,
      optionName: i.optionNameSnapshot,
      quantity: i.quantity,
      orderedAt: i.order.createdAt,
      deliveredAt: i.order.shipment?.deliveredAt ?? null,
      writableUntil: i.order.shipment?.deliveredAt ? new Date(i.order.shipment.deliveredAt.getTime() + policy.writableDays * DAY) : null,
    })),
    reviews: mine.map((r) => myView(r, slug, now, rewards.get(r.id)?.amount ?? 0)),
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
  const [i] = await writableItems(db, scope, now, policy.writableDays, { orderItemId });
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
    const ref = await db.orderItem.findFirst({ where: { id: orderItemId, sellerId: scope.sellerId }, select: { orderId: true } });
    if (!ref) return { ok: false, reason: "not_writable" };
    return await db.$transaction(async (tx) => {
      // 잠금 순서: 주문 → 회원. 잠근 뒤 아래 writableItems가 결제 완료·배송 완료를 다시 본다(그사이 환불됐으면 거절).
      const orderPaid = await lockOrderPaid(tx, scope.sellerId, ref.orderId);
      const [member] = await tx.$queryRaw<{ id: string; broadcastNickname: string }[]>`
        SELECT "id", "broadcastNickname" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
      if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
      const now = await lockedNow(tx);
      const policy = await policyOf(tx, scope.sellerId);
      const [item] = await writableItems(tx, scope, now, policy.writableDays, { orderItemId });
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
      const { granted } = await settleReward(tx, review, now, orderPaid);
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
      const locked = await lockReviewChain(tx, scope.sellerId, id);
      if (!locked || locked.review.buyerMemberId !== scope.buyerMemberId) throw notFound();
      const before = locked.review;
      const now = await lockedNow(tx);
      if (before.status === "HIDDEN" || now.getTime() >= before.createdAt.getTime() + REVIEW_EDIT_DAYS * DAY) return { ok: false as const, reason: "not_editable" as const };
      const policy = await policyOf(tx, scope.sellerId);
      const held = heldReason(p.v.body, policy.bannedWords);
      // 신고 누적 보류·공개 대기는 판매자가 풀 때까지 그대로 둔다. 신고 보류는 바뀔 수 있는 표시값(heldBy)이 아니라
      // 판매자가 아직 확인하지 않은 신고(resolvedAt 없음) 수로 판단해, 본문을 어떻게 고쳐도 풀리지 않는다.
      // 보류는 판매자만 푼다: 신고로 보류된 리뷰(heldBy=reports)는 그사이 신고자가 탈퇴해 미확인 신고가 줄어도 풀리지 않는다(MASTER 검수 ①).
      const reportHeld = before.status === "HELD" && (before.heldBy === "reports" || (await openReportCount(tx, scope.sellerId, id)) >= REVIEW_REPORT_HOLD);
      const status: ProductReviewStatus = reportHeld || held
        ? "HELD"
        : before.status === "HELD"
          ? policy.publishMode === "REVIEW"
            ? "PENDING"
            : "VISIBLE"
          : before.status;
      const heldBy = reportHeld ? "reports" : (held ?? null);
      // 사진은 한 번 리뷰에 붙으면 소진된다. 리뷰에서 뗀 사진은 지워 다른 리뷰에 다시 붙일 수 없게 한다(같은 사진으로 적립을 거듭 받지 못하게).
      const photosBefore = await tx.productReviewImage.count({ where: { sellerId: scope.sellerId, reviewId: id } });
      await reviewImageStore.delete(tx, { sellerId: scope.sellerId, reviewId: id, id: { notIn: p.v.imageIds } });
      if (!(await attachImages(tx, scope, id, p.v.imageIds))) throw new BadImages();
      await tx.productReview.update({ where: { id }, data: { rating: p.v.rating, body: p.v.body, status, heldBy, updatedAt: now } });
      // 리뷰 고치기는 적립 상태를 바꾸지 않는다(MASTER 원칙). 공개 여부(보류 ↔ 공개)나 사진 자격이 바뀔 때만 settleReward로 맞춘다.
      // 별점·본문만 고치면 설정이 바뀌었든, MANUAL 환불로 남겨 둔 적립이든 그대로 둔다(Codex 4177188513·4177247985).
      if (status !== before.status || photosBefore > 0 !== p.v.imageIds.length > 0) await settleReward(tx, { ...before, status, heldBy }, now, locked.orderPaid);
      await buyerAudit(tx, scope, meta, "buyer_review.update", id, { status, rating: p.v.rating, photos: p.v.imageIds.length });
      return { ok: true as const, status };
    });
  } catch (e) {
    if (e instanceof BadImages) return { ok: false, reason: "invalid_images" };
    throw e;
  }
}

// 지우기(작성자만, 언제든, 쇼핑몰 이용이 막히면 안 됨). 주문 상품 1개당 리뷰는 1번이라(MASTER 결정) 행은 묘비(deletedAt)로 남겨 다시 쓰지 못하게 하고,
// 본문·답글·사진·신고는 지운다. 목록·집계·공개에서는 빠진다. 적립은 settleReward로 0원에 맞춘다.
export async function deleteReview(db: PrismaClient, scope: BuyerScope, id: string, meta: AuditMeta = {}): Promise<Result<{ revokedReward: number }>> {
  if (!isUuid(id)) throw notFound();
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false, reason: "shop_unavailable" };
  return db.$transaction(async (tx) => {
    const locked = await lockReviewChain(tx, scope.sellerId, id);
    if (!locked || locked.review.buyerMemberId !== scope.buyerMemberId) throw notFound();
    const before = locked.review;
    const now = await lockedNow(tx);
    await reviewImageStore.delete(tx, { sellerId: scope.sellerId, reviewId: id });
    await tx.productReviewReport.deleteMany({ where: { sellerId: scope.sellerId, reviewId: id } });
    await tx.productReview.update({ where: { id }, data: { deletedAt: now, body: "", reply: null, repliedAt: null, updatedAt: now } });
    const { revoked } = await settleReward(tx, { ...before, deletedAt: now }, now, locked.orderPaid);
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
      // 잠금 순서: 주문 → 회원(작성자·신고한 회원) → 리뷰. 신고 보류는 적립도 바꾸므로 같은 순서를 따른다.
      const locked = await lockReviewChain(tx, scope.sellerId, id, scope.buyerMemberId);
      if (!locked || locked.review.status !== "VISIBLE") throw notFound();
      const before = locked.review;
      if (before.buyerMemberId === scope.buyerMemberId) return { ok: false as const, reason: "own_review" as const };
      const member = await tx.buyerMember.findFirst({ where: { id: scope.buyerMemberId, sellerId: scope.sellerId, status: "ACTIVE", deletedAt: null }, select: { id: true } });
      if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
      await tx.productReviewReport.create({ data: { sellerId: scope.sellerId, reviewId: id, buyerMemberId: member.id, reason } });
      // 현재 신고 수는 저장하지 않고 확인되지 않은 신고 행에서 센다(리뷰 행 잠금 아래라 겹친 신고도 차례로 센다)
      const held = (await openReportCount(tx, scope.sellerId, id)) >= REVIEW_REPORT_HOLD;
      if (held) await tx.productReview.update({ where: { id }, data: { status: "HELD", heldBy: "reports" } });
      if (held) await settleReward(tx, { ...before, status: "HELD", heldBy: "reports" }, await lockedNow(tx), locked.orderPaid);
      await buyerAudit(tx, scope, meta, "buyer_review.report", id, { reason, held });
      return { ok: true as const, held };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: "already_reported" };
    throw e;
  }
}

// 내 신고 철회(구매자가 자기 신고만). 철회한 신고는 미확인 신고 수·사유 집계에서 빠지고 행은 남는다. 리뷰 상태(신고 보류·적립)는 바꾸지 않는다:
// 보류 해제와 적립 복구는 판매자가 공개할 때만 한다(MASTER 결정). 잠금 순서는 신고와 같다(회원 → 주문 → 리뷰).
export async function withdrawReport(db: PrismaClient, scope: BuyerScope, id: string, meta: AuditMeta = {}): Promise<Result<{ openReports: number }>> {
  if (!isUuid(id)) throw notFound();
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false, reason: "shop_unavailable" };
  return db.$transaction(async (tx) => {
    const locked = await lockReviewChain(tx, scope.sellerId, id, scope.buyerMemberId);
    if (!locked) throw notFound();
    const now = await lockedNow(tx);
    // 아직 판매자가 확인하지 않았고 철회하지 않은 내 신고만 철회할 수 있다(없으면 404)
    const { count } = await tx.productReviewReport.updateMany({ where: { sellerId: scope.sellerId, reviewId: id, buyerMemberId: scope.buyerMemberId, resolvedAt: null, withdrawnAt: null }, data: { withdrawnAt: now } });
    if (count === 0) throw notFound();
    const openReports = await openReportCount(tx, scope.sellerId, id);
    await buyerAudit(tx, scope, meta, "buyer_review.report_withdraw", id, { openReports });
    return { ok: true as const, openReports };
  });
}

// 상품의 공개 리뷰(상품 상세에 끼울 목록): 평균·분포와 최근 순 목록. 운영 중이 아닌 쇼핑몰은 null.
export const PUBLIC_PAGE = 20;
export async function productReviews(db: PrismaClient, slug: string, productId: string, cursor?: string | null) {
  const seller = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!seller || !isUuid(productId) || !(await shopOpen(db, seller.id))) return null;
  const product = await db.product.findFirst({ where: { id: productId, sellerId: seller.id, ...SHOP_VISIBLE_PRODUCT }, select: { id: true } });
  if (!product) return null;
  const base = { sellerId: seller.id, productId, status: "VISIBLE" as const, deletedAt: null };
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
// 탈퇴 트랜잭션이 회원 행(NO KEY UPDATE)을 잡은 뒤 부른다(회원 → 리뷰 → 원장 순서). 적립은 settleReward로 맞춘다(탈퇴 회원이라 원하는 금액 0).
// 리뷰가 많은 회원도 시간 안에 끝나도록 집합 단위로 처리한다(Codex 4177188519): 유효 적립을 한 번에 조회하고 회수 원장을 한 번에 만든다.
// 탈퇴 회원이라 원하는 금액은 모두 0이고(settleReward와 같은 규칙), 회수 원장 상태는 createPendingRewardLedger와 같다(탈퇴 회원이면 실패).
// 리뷰 행을 하나씩 잠그지 않는 이유: 리뷰를 바꾸는 쓰기는 모두 작성자 회원 행을 공유 잠금으로 먼저 잡으므로, 탈퇴가 쥔 회원 행(NO KEY UPDATE)에서 막힌다.
export async function anonymizeMemberReviews(tx: Tx, scope: BuyerScope) {
  const now = await lockedNow(tx);
  const mine = await tx.productReview.findMany({ where: scope, select: { id: true, rewardRound: true, orderId: true } });
  const active = await activeRewards(tx, scope.sellerId, mine);
  if (active.size > 0) {
    const m = await tx.buyerMember.findUnique({ where: { id: scope.buyerMemberId }, select: { status: true } });
    const failed = m?.status === "WITHDRAWN";
    await tx.rewardLedger.createMany({
      data: mine
        .filter((r) => active.has(r.id))
        .map((r) => ({
          ...scope,
          orderId: r.orderId,
          type: "REVOKE" as const,
          amount: -active.get(r.id)!.amount,
          testMode: active.get(r.id)!.testMode,
          idempotencyKey: `review_revoke:${r.id}:${r.rewardRound}`,
          status: failed ? ("FAILED" as const) : ("PENDING" as const),
          failureReason: failed ? "member_withdrawn" : null,
          processedAt: failed ? now : null,
          createdAt: now,
        })),
    });
  }
  const reviews = await tx.productReview.updateMany({ where: scope, data: { authorNickname: WITHDRAWN_AUTHOR } });
  const images = await reviewImageStore.delete(tx, { ...scope, reviewId: null });
  // 신고 행은 지우지 않는다(보류 판단의 사실). 신고자 연결은 비식별된 탈퇴 회원 행만 가리킨다.
  return { reviews: reviews.count, images };
}

// 파트너스 관리자 문구(합니다체)
export const SELLER_REVIEW_MESSAGES: Record<SellerReviewFailure | "invalid_policy", string> = {
  invalid_reply: "답글은 1~300자로 입력해 주십시오.",
  invalid_reason: "숨김 사유를 골라 주십시오.",
  invalid_note: "사유 설명은 200자까지 입력할 수 있습니다.",
  invalid_policy: "리뷰 설정 값을 다시 확인해 주십시오. 적립금은 0~100,000원, 작성 기간은 1~365일, 금지어는 20자 이하 50개까지입니다.",
};
