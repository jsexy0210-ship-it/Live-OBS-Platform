import type { PrismaClient } from "@prisma/client";
import { ORDER_NOTICES } from "./messages";
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
  items: { select: { productNameSnapshot: true, optionNameSnapshot: true, unitPrice: true, quantity: true }, orderBy: { id: "asc" } },
  shipment: { select: { courier: true, trackingNumber: true, status: true, shippedAt: true, deliveredAt: true } },
} as const;

type Shipment = { courier: string; trackingNumber: string; status: string; shippedAt: Date; deliveredAt: Date | null } | null;
const withCourierName = (s: Shipment) => (s ? { ...s, courierName: isCourier(s.courier) ? COURIERS[s.courier] : s.courier } : null);

// 내부 값(stockShortageAt)은 빼고, 재고 부족으로 환불 대상인 결제 주문이면 구매자용 표시(needsRefund)와 안내 문구만 준다.
function forBuyer<T extends { status: string; stockShortageAt: Date | null; shipment: Shipment }>(o: T) {
  const { stockShortageAt, shipment, ...rest } = o;
  const needsRefund = o.status === "PAID" && stockShortageAt !== null;
  return { ...rest, shipment: withCourierName(shipment), needsRefund, notice: needsRefund ? ORDER_NOTICES.stock_shortage_refund : null };
}

// 목록: 최근 주문부터(createdAt 내림, id 내림), keyset 커서. 커서는 본인 주문 id만 받는다.
export async function listBuyerOrders(
  db: PrismaClient,
  scope: { sellerId: string; buyerMemberId: string },
  opts: { cursor?: unknown; limit?: unknown } = {},
) {
  const limit =
    opts.limit === undefined ? BUYER_ORDER_PAGE_SIZE : typeof opts.limit === "string" && /^\d+$/.test(opts.limit) ? Number(opts.limit) : typeof opts.limit === "number" ? opts.limit : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > BUYER_ORDER_MAX_PAGE_SIZE) return { ok: false as const, reason: "invalid_limit" as const };
  let after = {};
  if (opts.cursor !== undefined && opts.cursor !== "") {
    if (typeof opts.cursor !== "string" || !UUID.test(opts.cursor)) return { ok: false as const, reason: "invalid_cursor" as const };
    const c = await db.order.findFirst({ where: { id: opts.cursor, ...scope, legalHoldAt: null }, select: { id: true, createdAt: true } });
    if (!c) return { ok: false as const, reason: "invalid_cursor" as const };
    after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
  }
  const rows = await db.order.findMany({
    where: { ...scope, legalHoldAt: null, ...after },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: summarySelect,
  });
  const page = rows.slice(0, limit);
  return {
    ok: true as const,
    value: {
      orders: page.map(forBuyer),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    },
  };
}

// 상세: 목록 항목 + 본인 배송지 + 결제 수단.
export async function getBuyerOrder(db: PrismaClient, scope: { sellerId: string; buyerMemberId: string }, orderId: string) {
  if (!UUID.test(orderId)) return null;
  const o = await db.order.findFirst({
    where: { id: orderId, ...scope, legalHoldAt: null },
    select: {
      ...summarySelect,
      paymentMethod: true,
      shippingAddress: { select: { recipientName: true, phone: true, zipCode: true, address1: true, address2: true, memo: true } },
    },
  });
  return o ? forBuyer(o) : null;
}
