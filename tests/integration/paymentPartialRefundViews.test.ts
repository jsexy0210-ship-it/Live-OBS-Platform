import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { broadcastDetail } from "../../lib/server/broadcast/detail";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { getBuyerOrder } from "../../lib/server/orders/buyer";
import { getOrder, listSellerOrders } from "../../lib/server/orders/read";
import { listShipments } from "../../lib/server/orders/shipments";
import { markOrderPaid, previewRefundSelection, refundOrder, type RefundSelection } from "../../lib/server/queue/service";
import { buyerReturnContext, createReturn } from "../../lib/server/shop-returns/service";
import { orderStats } from "../../lib/server/stats/orders";
import { productStats } from "../../lib/server/stats/products";
import { parseStatsRange } from "../../lib/server/stats/range";
import { salesStats } from "../../lib/server/stats/sales";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 부분 환불 뒤 보이는 수량·금액(MASTER 배정 2026-10-05, 검수 #391 후속): 출고·주문 목록 요약, 주문 상세, 구매자 주문,
// 교환·반품 신청 가능 수량은 환불한 수량을 빼고, 통계는 결제 완료로 남은 부분 환불액도 매출에서 뺀다.
beforeEach(resetDb);
afterEach(() => vi.useRealTimers());
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };
const kstDay = (ms: number) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul" }).format(new Date(ms));
const today = () => kstDay(Date.now());
// 통계 시험은 시각에 따라 결과가 달라지면 안 된다: 실제 시각과 KST 자정 직후(00:10)에서 모두 돌린다(자정 직후엔 30분 전이 어제라 날짜 범위가 어제로 빠졌다).
const CLOCKS: [string, string | null][] = [["지금 시각", null], ["KST 자정 직후(00:10)", "2026-10-05T15:10:00Z"]];
const setClock = (at: string | null) => {
  if (at) vi.useFakeTimers({ toFake: ["Date"], now: new Date(at) });
};

// 박스 7,000원 × 1, 팩 5,000원 × 3(주문대기에서 빠진 품목이라 수량 일부 환불 가능), 배송비 3,000원
async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const box = await db.product.create({ data: { sellerId: seller.id, name: "박스", price: 7000, status: "ON_SALE" } });
  const pack = await db.product.create({ data: { sellerId: seller.id, name: "팩", price: 5000, status: "ON_SALE" } });
  const boxOpt = await db.productOption.create({ data: { sellerId: seller.id, productId: box.id, name: "1개", stock: 50 } });
  const packOpt = await db.productOption.create({ data: { sellerId: seller.id, productId: pack.id, name: "1개", stock: 50 } });
  const o = await createOrder(db, {
    sellerId: seller.id,
    buyerMemberId: buyer.id,
    items: [
      { optionId: boxOpt.id, quantity: 1 },
      { optionId: packOpt.id, quantity: 3 },
    ],
    consent,
    shippingAddress: addr,
  });
  if (!o.ok) throw new Error(o.reason);
  const paid = await markOrderPaid(db, { sellerId: seller.id, orderId: o.orderId, paymentMethod: "CARD" });
  if (!paid.ok) throw new Error(paid.reason);
  const items = await db.orderItem.findMany({ where: { orderId: o.orderId } });
  const boxItem = items.find((i) => i.optionId === boxOpt.id)!;
  const packItem = items.find((i) => i.optionId === packOpt.id)!;
  await db.queueItem.update({ where: { sellerId_orderItemId: { sellerId: seller.id, orderItemId: packItem.id } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  const order = await db.order.findUniqueOrThrow({ where: { id: o.orderId } });
  const refund = async (sel: RefundSelection | undefined) => {
    const p = await previewRefundSelection(db, ctx, o.orderId, sel);
    if (!p.ok) throw new Error(p.reason);
    const liveVersion = (await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).liveVersion;
    const r = await refundOrder(db, ctx, o.orderId, { reason: "부분", expectedLiveVersion: liveVersion, fault: "SELLER", expectedRefundAmount: p.value.byFault.SELLER.refundAmount, items: sel });
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  };
  return { seller, ctx, buyer, order, boxItem, packItem, refund, scope: { sellerId: seller.id, buyerMemberId: buyer.id } };
}

const shipmentRow = async (s: Awaited<ReturnType<typeof setup>>) => {
  const r = await listShipments(db, s.ctx, { tab: "ready" });
  if (!r.ok) throw new Error("list");
  return r.shipments.find((x) => x.orderId === s.order.id) ?? null;
};

describe("부분 환불 뒤 수량 표시", () => {
  it("출고 목록·주문 목록 요약은 다 돌려준 품목을 빼고, 남은 품목이 없으면(주문 환불) 출고 목록에서 사라진다", async () => {
    const s = await setup();
    // 두 품목은 같은 시각에 만들어져 첫 상품은 id 순서로 정해진다(어느 쪽이든 외 1건)
    expect((await shipmentRow(s))?.itemSummary).toEqual({ firstProductName: expect.stringMatching(/^(박스|팩)$/), otherCount: 1, refundedQuantity: 0 });
    await s.refund([{ orderItemId: s.boxItem.id, quantity: 1 }]);
    expect((await shipmentRow(s))?.itemSummary).toEqual({ firstProductName: "팩", otherCount: 0, refundedQuantity: 1 });
    await s.refund([{ orderItemId: s.packItem.id, quantity: 1 }]);
    expect((await shipmentRow(s))?.itemSummary).toEqual({ firstProductName: "팩", otherCount: 0, refundedQuantity: 2 });
    const list = await listSellerOrders(db, s.ctx, {});
    if (!list.ok) throw new Error("list");
    expect(list.orders.find((o) => o.id === s.order.id)?.itemSummary).toEqual({ firstProductName: "팩", otherCount: 0, refundedQuantity: 2 });
    // 실제 환불 흐름 뒤 목록 행의 환불 현황: 현금 환불 합계는 주문의 refundAmount, 남은 금액은 합계에서 뺀 값
    const partial = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
    expect(partial.refundAmount).toBeGreaterThan(0);
    expect(list.orders.find((o) => o.id === s.order.id)).toMatchObject({
      status: "PAID",
      refundedAmount: partial.refundAmount,
      refundedQuantity: 2,
      remainingAmount: partial.totalAmount - partial.refundAmount!,
    });
    await s.refund(undefined);
    expect(await shipmentRow(s)).toBeNull();
    // 전부 환불된 주문의 목록 요약은 모든 품목으로 보여 준다
    const after = await listSellerOrders(db, s.ctx, {});
    if (!after.ok) throw new Error("list");
    expect(after.orders.find((o) => o.id === s.order.id)?.itemSummary).toEqual({ firstProductName: expect.stringMatching(/^(박스|팩)$/), otherCount: 1, refundedQuantity: 4 });
    const done = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
    expect(after.orders.find((o) => o.id === s.order.id)).toMatchObject({ status: "REFUNDED", refundedAmount: done.refundAmount, refundedQuantity: 4, remainingAmount: done.totalAmount - done.refundAmount! });
  });

  it("파트너스 주문 상세는 품목마다 환불한 수량과 보낼 수량, 구매자 주문 상세는 환불한 수량을 준다", async () => {
    const s = await setup();
    await s.refund([{ orderItemId: s.packItem.id, quantity: 2 }]);
    const o = await getOrder(db, s.ctx, s.order.id);
    expect(o.items.find((i) => i.id === s.packItem.id)).toMatchObject({ quantity: 3, refundedQuantity: 2, shipQuantity: 1 });
    expect(o.items.find((i) => i.id === s.boxItem.id)).toMatchObject({ quantity: 1, refundedQuantity: 0, shipQuantity: 1 });
    const b = await getBuyerOrder(db, s.scope, s.order.id);
    expect(b?.items.map((i) => [i.productNameSnapshot, i.quantity, i.refundedQuantity]).sort()).toEqual([
      ["박스", 1, 0],
      ["팩", 3, 2],
    ]);
  });

  it("교환·반품 신청은 다 돌려준 품목을 빼고 남은 수량으로만 받는다", async () => {
    const s = await setup();
    await s.refund([{ orderItemId: s.boxItem.id, quantity: 1 }]);
    await s.refund([{ orderItemId: s.packItem.id, quantity: 1 }]);
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: s.order.id, courier: "CJ", trackingNumber: "123456789012", status: "DELIVERED", shippedAt: new Date(), deliveredAt: new Date() } });
    const ctx = await buyerReturnContext(db, s.scope, s.order.id);
    expect(ctx?.items).toEqual([{ orderItemId: s.packItem.id, productName: "팩", optionName: "1개", quantity: 2, opened: false }]);
    expect(await createReturn(db, s.scope, s.order.id, { kind: "EXCHANGE", reason: "DEFECTIVE", orderItemIds: [s.boxItem.id] })).toMatchObject({ ok: false, reason: "invalid_items" });
    const r = await createReturn(db, s.scope, s.order.id, { kind: "RETURN", reason: "DEFECTIVE" });
    expect(r.ok).toBe(true);
    const items = await db.returnRequestItem.findMany({ where: { sellerId: s.seller.id } });
    expect(items.map((i) => [i.orderItemId, i.quantity])).toEqual([[s.packItem.id, 2]]);
  });

  it.each(CLOCKS)("통계: 결제 완료로 남은 부분 환불액도 환불액에 넣고 순매출에서 뺀다(%s)", async (_label, at) => {
    setClock(at);
    const s = await setup();
    await s.refund([{ orderItemId: s.boxItem.id, quantity: 1 }]);
    const range = parseStatsRange({ from: today(), to: today() })!;
    const os = await orderStats(db, s.ctx, range);
    expect(os.current).toMatchObject({ revenue: s.order.totalAmount, refundAmount: 7000, netRevenue: s.order.totalAmount - 7000, refunded: 0 });
    const ss = await salesStats(db, s.ctx, range);
    expect(ss.current).toMatchObject({ paid: s.order.totalAmount, refund: 7000, net: s.order.totalAmount - 7000 });
    await s.refund(undefined);
    const after = await orderStats(db, s.ctx, range);
    expect(after.current).toMatchObject({ refundAmount: s.order.totalAmount, netRevenue: 0, refunded: 1 });
  });

  it.each(CLOCKS)("상품 통계는 부분 환불한 수량·매출을 빼고 다 돌려준 품목은 판매 없음, 방송 상세는 품목별 환불 수량과 부분 환불액을 뺀 매출(%s)", async (_label, at) => {
    setClock(at);
    const s = await setup();
    const session = await db.broadcastSession.create({ data: { sellerId: s.seller.id, status: "LIVE", startedAt: new Date(Date.now() - 3600_000) } });
    // setup의 주문은 방송 시작 뒤에 만들어졌다
    await db.order.update({ where: { id: s.order.id }, data: { createdAt: new Date(Date.now() - 1800_000) } });
    await s.refund([{ orderItemId: s.boxItem.id, quantity: 1 }]);
    await s.refund([{ orderItemId: s.packItem.id, quantity: 1 }]);
    // 주문 시각을 30분 전으로 옮겼으므로 KST 자정 직후엔 어제다: 어제~오늘 범위로 본다
    const ps = await productStats(db, s.ctx, parseStatsRange({ from: kstDay(Date.now() - 86_400_000), to: today() })!);
    expect(ps.current).toEqual({ quantity: 2, revenue: 10000, products: 1 });
    expect(ps.topByQuantity.map((r) => [r.name, r.quantity, r.revenue])).toEqual([["팩", 2, 10000]]);
    expect(ps.unsold.map((u) => u.name)).toContain("박스");

    const d = await broadcastDetail(db, s.ctx, session.id);
    const o = d.orders.find((x) => x.id === s.order.id)!;
    expect(o.items.map((i) => [i.productName, i.quantity, i.refundedQuantity]).sort()).toEqual([
      ["박스", 1, 1],
      ["팩", 3, 1],
    ]);
    expect(d.summary.sales).toBe(s.order.totalAmount - 12000);
  });
});
