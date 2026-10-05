import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { getOrderHistory } from "../../lib/server/orders/history";
import { markOrderPaid, previewRefundSelection, refundOrder, type RefundSelection } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-022 주문 상세의 상태 이력(getOrderHistory, GET /api/seller/orders/{id}의 history): 상태 변경·결제 승인·일부 환불·결제 취소를 시각순으로.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };

// 팩 5,000원 × 3(주문대기에서 빠진 품목이라 수량 일부 환불 가능) + 배송비 3,000원 = 18,000원, 카드 결제 행 포함
async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER", "owner-history@example.com");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const pack = await db.product.create({ data: { sellerId: seller.id, name: "팩", price: 5000, status: "ON_SALE" } });
  const packOpt = await db.productOption.create({ data: { sellerId: seller.id, productId: pack.id, name: "1개", stock: 50 } });
  const o = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: packOpt.id, quantity: 3 }], consent, shippingAddress: addr });
  if (!o.ok) throw new Error(o.reason);
  const paid = await markOrderPaid(db, { sellerId: seller.id, orderId: o.orderId, paymentMethod: "CARD" });
  if (!paid.ok) throw new Error(paid.reason);
  const order = await db.order.findUniqueOrThrow({ where: { id: o.orderId } });
  const item = await db.orderItem.findFirstOrThrow({ where: { orderId: o.orderId } });
  await db.queueItem.update({ where: { sellerId_orderItemId: { sellerId: seller.id, orderItemId: item.id } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  await db.payment.create({
    data: { sellerId: seller.id, orderId: o.orderId, provider: "nicepay", method: "CARD", status: "PAID", amount: order.totalAmount, pgTid: "tid-history-1", approvedAt: new Date() },
  });
  const refund = async (sel: RefundSelection | undefined) => {
    const p = await previewRefundSelection(db, ctx, o.orderId, sel);
    if (!p.ok) throw new Error(p.reason);
    const liveVersion = (await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).liveVersion;
    const r = await refundOrder(db, ctx, o.orderId, { reason: "시험 환불", expectedLiveVersion: liveVersion, fault: "SELLER", expectedRefundAmount: p.value.byFault.SELLER.refundAmount, items: sel });
    if (!r.ok) throw new Error(r.reason);
    return r.value;
  };
  return { seller, owner, ctx, order, item, refund };
}

describe("주문 상세 상태 이력", () => {
  it("결제 승인 → 일부 환불(처리자·금액·수량·사유) → 결제 취소 요청 → 전체 환불이 시각 순서로 나오고, 이메일·id는 나오지 않는다", async () => {
    const s = await setup();
    const first = await getOrderHistory(db, s.ctx, s.order.id);
    expect(first.map((e) => [e.kind, e.status])).toEqual([["status", "PENDING_PAYMENT"], ["status", "PAID"], ["payment_approved", null]]);
    expect(first.find((e) => e.kind === "payment_approved")).toMatchObject({ amount: s.order.totalAmount, actor: { type: "SYSTEM" } });

    await s.refund([{ orderItemId: s.item.id, quantity: 1 }]);
    const mid = await getOrderHistory(db, s.ctx, s.order.id);
    const partial = mid.find((e) => e.kind === "refund_partial");
    expect(partial).toMatchObject({ amount: 5000, quantity: 1, note: "시험 환불", actor: { type: "SELLER", role: "OWNER", name: "직원" } });
    expect(mid.find((e) => e.kind === "payment_cancel")).toMatchObject({ amount: 5000, cancelStatus: "REQUESTED" });
    expect(mid.some((e) => e.status === "REFUNDED")).toBe(false);

    await s.refund(undefined);
    const last = await getOrderHistory(db, s.ctx, s.order.id);
    expect(last.find((e) => e.status === "REFUNDED")).toMatchObject({ kind: "status", status: "REFUNDED", fromStatus: "PAID", note: "시험 환불", actor: { type: "SELLER", role: "OWNER" } });
    expect(last.filter((e) => e.kind === "payment_cancel").map((e) => e.amount)).toEqual([5000, 13000]);
    expect([...last].sort((a, b) => a.at.localeCompare(b.at))).toEqual(last);
    const json = JSON.stringify(last);
    expect(json).not.toContain("owner-history@example.com");
    expect(json).not.toContain(s.owner.id);
  });

  it("다른 파트너스의 주문 이력은 비어 있다(판매자 격리)", async () => {
    const s = await setup();
    const other = await createSeller();
    const otherOwner = await createSellerUser(other.seller.id, "OWNER");
    const otherCtx: TenantContext = { sellerId: other.seller.id, actorType: "SELLER_USER", actorId: otherOwner.id, isOwner: true, permissions: [], readOnly: false };
    expect(await getOrderHistory(db, otherCtx, s.order.id)).toEqual([]);
  });
});
