import type { PrismaClient } from "@prisma/client";
import { thumbnailUrls } from "../products/images";
import { ORDER_NOTICES } from "./messages";
import { kstDayStart } from "./read";
import { orderNoLabel } from "./orderNoLabel";
import { COURIERS, isCourier } from "./shipping";

// 구매자 본인 주문 조회(목록·상세). 조회 조건에는 항상 쇼핑몰(sellerId)과 본인(buyerMemberId)이 함께 들어가고,
// 다른 구매자·다른 쇼핑몰 주문은 없는 주문(404)으로 본다. 잠긴 쇼핑몰이어도 기존 주문 조회는 연다(PRODUCT_SCOPE 「잠금 중 허용 범위」).
// 내부 값(결제사 거래 번호, 재고 부족 시각, 판매자·회원 id)은 내려주지 않는다. 응답은 캐시하지 않는다(no-store). 배송지는 본인 상세 조회에서만 준다.

export const BUYER_ORDER_PAGE_SIZE = 20;
export const BUYER_ORDER_MAX_PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const summarySelect = {
  id: true,
  orderNo: true,
  status: true,
  totalAmount: true,
  shippingFee: true,
  createdAt: true,
  paidAt: true,
  cancelledAt: true,
  refundedAt: true,
  // 환불 금액·사유 주체(구매자·판매자 사정)·뺀 반품 배송비, 구매 확정 시각
  refundAmount: true,
  refundFault: true,
  returnFeeDeducted: true,
  purchaseConfirmedAt: true,
  paymentDueAt: true,
  stockShortageAt: true,
  // 쓴 쿠폰과 할인 금액(전체 취소로 되돌렸으면 restoredAt)
  couponRedemption: { select: { discountAmount: true, restoredAt: true, coupon: { select: { name: true } } } },
  // refundedQuantity: 부분 환불로 돌려준 수량(받을 수량 = quantity − refundedQuantity)
  items: { select: { productNameSnapshot: true, optionNameSnapshot: true, unitPrice: true, quantity: true, refundedQuantity: true }, orderBy: { id: "asc" } },
  shipment: { select: { courier: true, trackingNumber: true, status: true, shippedAt: true, deliveredAt: true } },
} as const;

type Shipment = { courier: string; trackingNumber: string; status: string; shippedAt: Date; deliveredAt: Date | null } | null;
const withCourierName = (s: Shipment) => (s ? { ...s, courierName: isCourier(s.courier) ? COURIERS[s.courier] : s.courier } : null);

// 내부 값(stockShortageAt)은 빼고, 재고 부족으로 환불 대상인 결제 주문이면 구매자용 표시(needsRefund)와 안내 문구만 준다.
function forBuyer<T extends { status: string; stockShortageAt: Date | null; shipment: Shipment; orderNo: number; createdAt: Date }>(o: T) {
  const { stockShortageAt, shipment, ...rest } = o;
  const needsRefund = o.status === "PAID" && stockShortageAt !== null;
  return { ...rest, orderNoLabel: orderNoLabel(o.createdAt, o.orderNo), shipment: withCourierName(shipment), needsRefund, notice: needsRefund ? ORDER_NOTICES.stock_shortage_refund : null };
}

// 품목별 추가 값(상세·목록 공통): 다시 담기용 상품·옵션 id, 대표 사진 주소, 대기열(상태·내 순번·시각).
// 주문 안의 품목 순서는 orderItem.id 오름차순(summarySelect의 items와 같다). 대기열은 내 품목의 상태와 「내 앞 대기 수」 숫자만 주고 다른 구매자 정보는 주지 않는다.
type QueueView = { status: "WAITING" | "OPENING" | "DONE" | "CANCELLED"; waitingNumber: number | null; receivedAt: Date; openingStartedAt: Date | null; doneAt: Date | null; cancelledAt: Date | null };
type ItemExtra = { productId: string; optionId: string; imageUrl: string | null; queue: QueueView | null };

async function loadItemExtras(db: PrismaClient, sellerId: string, slug: string | undefined, orderIds: string[]): Promise<Map<string, ItemExtra[]>> {
  const out = new Map<string, ItemExtra[]>();
  if (orderIds.length === 0) return out;
  const [itemRows, queueRows] = await Promise.all([
    db.orderItem.findMany({ where: { sellerId, orderId: { in: orderIds } }, select: { id: true, orderId: true, productId: true, optionId: true }, orderBy: { id: "asc" } }),
    db.queueItem.findMany({
      where: { sellerId, orderId: { in: orderIds } },
      select: { id: true, orderItemId: true, status: true, receivedAt: true, openingStartedAt: true, doneAt: true, cancelledAt: true },
    }),
  ]);
  const images = await thumbnailUrls(db, sellerId, [...new Set(itemRows.map((i) => i.productId))], slug);
  // 대기 중 항목마다 내 앞의 대기 수(같은 쇼핑몰의 WAITING 중 순서가 앞인 것)
  const waitingIds = queueRows.filter((q) => q.status === "WAITING").map((q) => q.id);
  const ahead = new Map<string, number>();
  if (waitingIds.length > 0) {
    const rows = await db.$queryRaw<{ id: string; ahead: number }[]>`
      SELECT q."id", (SELECT count(*)::int FROM "QueueItem" w WHERE w."sellerId" = q."sellerId" AND w."status" = 'WAITING' AND w."position" < q."position") AS "ahead"
      FROM "QueueItem" q WHERE q."sellerId" = ${sellerId}::uuid AND q."id" = ANY(${waitingIds}::uuid[])`;
    for (const r of rows) ahead.set(r.id, r.ahead);
  }
  const queueOf = new Map(queueRows.filter((q) => q.orderItemId).map((q) => [q.orderItemId as string, q]));
  for (const row of itemRows) {
    const q = queueOf.get(row.id);
    const list = out.get(row.orderId) ?? [];
    list.push({
      productId: row.productId,
      optionId: row.optionId,
      imageUrl: images.get(row.productId) ?? null,
      queue: q
        ? { status: q.status, waitingNumber: q.status === "WAITING" ? (ahead.get(q.id) ?? 0) + 1 : null, receivedAt: q.receivedAt, openingStartedAt: q.openingStartedAt, doneAt: q.doneAt, cancelledAt: q.cancelledAt }
        : null,
    });
    out.set(row.orderId, list);
  }
  return out;
}

// 주문 단위 개봉 요약(목록의 「개봉 대기 · 앞에 N명」용): 개봉 중이 있으면 OPENING, 아니면 대기 중이 있으면 WAITING(앞 대기 수는 가장 앞선 항목 기준),
// 아니면 모두 끝났으면 DONE, 대기열에 오른 항목이 없거나 전부 취소면 null.
function queueSummary(extras: ItemExtra[]) {
  const qs = extras.map((e) => e.queue).filter((q): q is QueueView => q !== null && q.status !== "CANCELLED");
  if (qs.length === 0) return null;
  if (qs.some((q) => q.status === "OPENING")) return { status: "OPENING" as const, aheadCount: 0 };
  const waiting = qs.filter((q) => q.status === "WAITING");
  if (waiting.length > 0) return { status: "WAITING" as const, aheadCount: Math.min(...waiting.map((q) => (q.waitingNumber ?? 1) - 1)) };
  return { status: "DONE" as const, aheadCount: 0 };
}

function withExtras<T extends { id: string; items: object[] }>(view: T, extras: ItemExtra[] | undefined) {
  const list = extras ?? [];
  return {
    ...view,
    items: view.items.map((it, idx) => ({ ...it, productId: list[idx]?.productId ?? null, optionId: list[idx]?.optionId ?? null, imageUrl: list[idx]?.imageUrl ?? null, queue: list[idx]?.queue ?? null })),
    queue: queueSummary(list),
  };
}

// 목록의 탭(주문 내역 6개): all 전체, pending 결제 대기, inProgress 진행 중(결제 완료·아직 배송 완료/구매 확정 전), done 완료(배송 완료 또는 구매 확정),
// cancelled 취소, refunded 환불. 부분 환불한 주문은 결제 완료 그대로 진행 중·완료로 센다.
export const BUYER_ORDER_TABS = ["all", "pending", "inProgress", "done", "cancelled", "refunded"] as const;
export type BuyerOrderTab = (typeof BUYER_ORDER_TABS)[number];
const DAY_MS = 86_400_000;
export const BUYER_ORDER_RANGE_MAX_DAYS = 366;
const KST_MS = 9 * 3_600_000;
const kstToday = (now: Date) => new Date(now.getTime() + KST_MS).toISOString().slice(0, 10);
// 기본 기간: 오늘(KST)부터 한 달 전 같은 날까지(최근 1개월)
function defaultFrom(to: string) {
  const [y, m, d] = to.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 2, 1));
  const lastDay = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d, lastDay));
  return dt.toISOString().slice(0, 10);
}

// 목록: 최근 주문부터(createdAt 내림, id 내림), keyset 커서. 커서는 본인 주문 id만 받는다.
// 기간 from·to(KST 날짜, 둘 다 포함, 기본 최근 1개월), 탭 tab(기본 all), counts는 같은 기간의 탭별 전체 개수(탭·커서와 무관).
export async function listBuyerOrders(
  db: PrismaClient,
  scope: { sellerId: string; buyerMemberId: string },
  opts: { cursor?: unknown; limit?: unknown; tab?: unknown; from?: unknown; to?: unknown; now?: Date } = {},
) {
  const limit =
    opts.limit === undefined ? BUYER_ORDER_PAGE_SIZE : typeof opts.limit === "string" && /^\d+$/.test(opts.limit) ? Number(opts.limit) : typeof opts.limit === "number" ? opts.limit : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > BUYER_ORDER_MAX_PAGE_SIZE) return { ok: false as const, reason: "invalid_limit" as const };
  const tab = opts.tab === undefined || opts.tab === "" ? "all" : opts.tab;
  if (typeof tab !== "string" || !(BUYER_ORDER_TABS as readonly string[]).includes(tab)) return { ok: false as const, reason: "invalid_tab" as const };
  const str = (v: unknown) => (v === undefined || v === "" || v === null ? undefined : typeof v === "string" ? v : null);
  const fromIn = str(opts.from);
  const toIn = str(opts.to);
  if (fromIn === null || toIn === null) return { ok: false as const, reason: "invalid_range" as const };
  const to = toIn ?? kstToday(opts.now ?? new Date());
  const toStart = kstDayStart(to);
  if (!toStart) return { ok: false as const, reason: "invalid_range" as const };
  const from = fromIn ?? defaultFrom(to);
  const start = kstDayStart(from);
  if (!start || toStart < start || Math.round((toStart.getTime() - start.getTime()) / DAY_MS) + 1 > BUYER_ORDER_RANGE_MAX_DAYS) return { ok: false as const, reason: "invalid_range" as const };
  const end = new Date(toStart.getTime() + DAY_MS);
  const inRange = { gte: start, lt: end };

  let after = {};
  if (opts.cursor !== undefined && opts.cursor !== "") {
    if (typeof opts.cursor !== "string" || !UUID.test(opts.cursor)) return { ok: false as const, reason: "invalid_cursor" as const };
    const c = await db.order.findFirst({ where: { id: opts.cursor, ...scope, legalHoldAt: null }, select: { id: true, createdAt: true } });
    if (!c) return { ok: false as const, reason: "invalid_cursor" as const };
    after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
  }
  const done = { shipment: { is: { status: "DELIVERED" as const } } };
  const confirmed = { purchaseConfirmedAt: { not: null } };
  const tabWhere =
    tab === "pending" ? { status: "PENDING_PAYMENT" as const }
    : tab === "cancelled" ? { status: "CANCELLED" as const }
    : tab === "refunded" ? { status: "REFUNDED" as const }
    : tab === "done" ? { status: "PAID" as const, OR: [done, confirmed] }
    : tab === "inProgress" ? { status: "PAID" as const, NOT: { OR: [done, confirmed] } }
    : {};
  const rows = await db.order.findMany({
    where: { ...scope, legalHoldAt: null, createdAt: inRange, ...tabWhere, ...after },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: summarySelect,
  });
  const page = rows.slice(0, limit);
  const [seller, countRows] = await Promise.all([
    db.seller.findUnique({ where: { id: scope.sellerId }, select: { slug: true } }),
    db.$queryRaw<{ tab: string; n: number }[]>`
      SELECT CASE
          WHEN o."status" = 'PENDING_PAYMENT' THEN 'pending'
          WHEN o."status" = 'CANCELLED' THEN 'cancelled'
          WHEN o."status" = 'REFUNDED' THEN 'refunded'
          WHEN o."purchaseConfirmedAt" IS NOT NULL OR s."status" = 'DELIVERED' THEN 'done'
          ELSE 'inProgress' END AS "tab", count(*)::int AS "n"
      FROM "Order" o LEFT JOIN "Shipment" s ON s."sellerId" = o."sellerId" AND s."orderId" = o."id"
      WHERE o."sellerId" = ${scope.sellerId}::uuid AND o."buyerMemberId" = ${scope.buyerMemberId}::uuid AND o."legalHoldAt" IS NULL
        AND o."createdAt" >= ${start} AND o."createdAt" < ${end}
      GROUP BY 1`,
  ]);
  // 사진·대기열은 주문마다 따로 묻지 않고 한 번에 읽는다
  const extraMap = await loadItemExtras(db, scope.sellerId, seller?.slug, page.map((o) => o.id));
  const counts = { all: 0, pending: 0, inProgress: 0, done: 0, cancelled: 0, refunded: 0 };
  for (const r of countRows) {
    counts[r.tab as Exclude<BuyerOrderTab, "all">] = r.n;
    counts.all += r.n;
  }
  return {
    ok: true as const,
    value: {
      orders: page.map((o) => withExtras(forBuyer(o), extraMap.get(o.id))),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
      range: { from, to },
      counts,
    },
  };
}

// 상세: 목록 항목 + 본인 배송지 + 결제 수단·카드 요약 + 받는 방법 + 현금영수증 신청 + 품목별 사진·옵션 id·대기열(순번·개봉 상태).
// 모든 조회에 쇼핑몰·본인이 걸려 있다. 카드는 카드사 이름·끝 4자리·할부 개월만(번호 전체·유효기간·결제사 거래 번호는 없음).
export async function getBuyerOrder(db: PrismaClient, scope: { sellerId: string; buyerMemberId: string }, orderId: string) {
  if (!UUID.test(orderId)) return null;
  const o = await db.order.findFirst({
    where: { id: orderId, ...scope, legalHoldAt: null },
    select: {
      ...summarySelect,
      paymentMethod: true,
      fulfillmentType: true,
      shippingAddress: { select: { recipientName: true, phone: true, zipCode: true, address1: true, address2: true, memo: true } },
    },
  });
  if (!o) return null;
  const [seller, payment, receipt] = await Promise.all([
    db.seller.findUnique({ where: { id: scope.sellerId }, select: { slug: true } }),
    db.payment.findFirst({
      where: { orderId, sellerId: scope.sellerId, status: { in: ["PAID", "PARTIAL_CANCELLED", "CANCELLED"] } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { cardName: true, cardLast4: true, cardInstallment: true },
    }),
    db.orderReceiptRequest.findFirst({
      where: { orderId, sellerId: scope.sellerId, buyerMemberId: scope.buyerMemberId, withdrawnAt: null },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { kind: true, createdAt: true },
    }),
  ]);
  const extras = (await loadItemExtras(db, scope.sellerId, seller?.slug, [orderId])).get(orderId);
  return {
    ...withExtras(forBuyer(o), extras),
    paymentInfo: {
      method: o.paymentMethod,
      card: payment && (payment.cardName || payment.cardLast4 || payment.cardInstallment !== null) ? { name: payment.cardName, last4: payment.cardLast4, installment: payment.cardInstallment } : null,
    },
    cashReceipt: receipt ? { requested: true, kind: receipt.kind, requestedAt: receipt.createdAt } : { requested: false, kind: null, requestedAt: null },
  };
}
