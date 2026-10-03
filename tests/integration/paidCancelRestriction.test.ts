import type { RefundFault } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { PAID_CANCEL_LIMIT, RESTRICTION_DAYS, liftRestriction, readOrderPolicy, updateOrderPolicy } from "../../lib/server/orders/overdue";
import { refundOrder } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createLoginBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const BASE = { autoCancelEnabled: true, paymentDueHours: 24, unpaidRestrictionEnabled: true };
const addr = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const lv = async () => (await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).liveVersion;
  // 결제 완료 주문을 만들고 바로 환불한다(발송 전)
  const refund = async (fault?: RefundFault) => {
    const { order } = await createPaidOrderItem(seller.id, buyer.id);
    const r = await refundOrder(db, ctx, order.id, { reason: "취소 요청", expectedLiveVersion: await lv(), ...(fault ? { fault } : {}) });
    expect(r.ok).toBe(true);
    return order.id;
  };
  const place = async () => {
    const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 10 } });
    return createOrder(db, {
      sellerId: seller.id,
      buyerMemberId: buyer.id,
      items: [{ optionId: option.id, quantity: 1 }],
      consent: { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version },
      shippingAddress: addr,
    });
  };
  const restrictions = () => db.buyerPurchaseRestriction.findMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id }, orderBy: { startsAt: "asc" } });
  return { seller, ctx, buyer, refund, place, restrictions };
}

describe("결제 후 취소 5회 → 30일 구매 제한", () => {
  it("기본은 꺼져 있어 환불이 쌓여도 제한하지 않는다", async () => {
    const s = await shop();
    expect((await readOrderPolicy(db, s.ctx)).paidCancelRestrictionEnabled).toBe(false);
    for (let i = 0; i < PAID_CANCEL_LIMIT + 1; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toEqual([]);
    expect((await s.place()).ok).toBe(true);
  });

  it("켜면 그 뒤 판매자 사정이 아닌 환불 5회째에 30일 제한을 걸고, 켜기 전 환불·판매자 사정 환불은 세지 않는다", async () => {
    const s = await shop();
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund("BUYER");
    expect(await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true })).toMatchObject({ ok: true, policy: { paidCancelRestrictionEnabled: true } });
    await s.refund("SELLER");
    await s.refund("SELLER");
    for (const f of ["BUYER", undefined, "BUYER", undefined] as const) await s.refund(f);
    expect(await s.restrictions()).toEqual([]);
    const last = await s.refund("BUYER");
    const [r] = await s.restrictions();
    expect(r).toMatchObject({ reason: "PAID_CANCEL", liftedAt: null });
    expect(r.endsAt.getTime() - r.startsAt.getTime()).toBe(RESTRICTION_DAYS * 24 * 60 * 60 * 1000);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.purchase_restriction.create", targetId: s.buyer.id } })).toMatchObject({
      actorType: "SYSTEM",
      after: { reason: "PAID_CANCEL", paidCancels: PAID_CANCEL_LIMIT },
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: last } })).status).toBe("REFUNDED");
    // 제한 중 새 주문은 막는다
    expect(await s.place()).toMatchObject({ ok: false, reason: "purchase_restricted", endsAt: r.endsAt });
    // 꺼도 이미 걸린 제한은 그대로 둔다
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: false });
    expect(await s.place()).toMatchObject({ ok: false, reason: "purchase_restricted" });
  });

  it("판매자가 풀면 그 뒤 환불만 다시 센다", async () => {
    const s = await shop();
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(1);
    expect(await liftRestriction(db, s.ctx, s.buyer.id)).toMatchObject({ ok: true });
    expect((await s.restrictions())[0].liftedAt).not.toBeNull();
    for (let i = 0; i < PAID_CANCEL_LIMIT - 1; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(1);
    await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(2);
  });

  it("설정: 빼고 보내면 지금 값을 유지하고, 불리언이 아니면 400, 껐다 켜면 켠 뒤 환불만 센다", async () => {
    const s = await shop();
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    expect(await updateOrderPolicy(db, s.ctx, BASE)).toMatchObject({ ok: true, policy: { paidCancelRestrictionEnabled: true } });
    expect(await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: "yes" })).toEqual({ ok: false, reason: "invalid_order_policy" });
    for (let i = 0; i < PAID_CANCEL_LIMIT - 1; i++) await s.refund("BUYER");
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: false });
    await s.refund("BUYER");
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    for (let i = 0; i < PAID_CANCEL_LIMIT - 1; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toEqual([]);
    await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(1);
  });
});
