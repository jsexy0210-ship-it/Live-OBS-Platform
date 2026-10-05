import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { cancelOverdueOrders } from "../../lib/server/orders/overdue";
import { shipOrder } from "../../lib/server/orders/ship";
import { FakePaymentGateway } from "../../lib/server/payments/gateway";
import { parseRewardUse, rewardReturnAmount, rewardUseLimit } from "../../lib/server/payments/rewardUse";
import { startPayment } from "../../lib/server/payments/service";
import { cancelPendingOrder, markOrderPaid, refundOrder } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const shippingAddress = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

// 상품 5,000원, 기본 배송비 3,000원. 회원 적립금 잔액 10,000원, 실지급 스위치 켜짐.
async function shop(opts: { balance?: number; live?: boolean; freeShipping?: boolean } = {}) {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock: 100 } });
  await db.rewardPolicy.create({ data: { sellerId: seller.id, livePayoutEnabled: opts.live ?? true } });
  await db.rewardBalance.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, balance: opts.balance ?? 10000 } });
  if (opts.freeShipping) await db.sellerShippingPolicy.create({ data: { sellerId: seller.id, freeShipping: true } });
  const order = (rewardUseAmount: unknown, quantity = 1) =>
    createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity }], consent, shippingAddress, rewardUseAmount });
  return { seller, owner, ctx, buyer, option, order };
}

const balanceOf = async (sellerId: string, buyerMemberId: string) =>
  (await db.rewardBalance.findUniqueOrThrow({ where: { sellerId_buyerMemberId: { sellerId, buyerMemberId } } })).balance;
const lv = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;

describe("적립금 사용 규칙(계산)", () => {
  it("1,000원 이상 10원 단위, 한도는 상품 금액(상품 쿠폰 뺀 값)이고 결제할 금액이 1원 이상 남는다", () => {
    expect([undefined, null, 0].map(parseRewardUse)).toEqual([0, 0, 0]);
    expect([1000, 1010, 25000].map(parseRewardUse)).toEqual([1000, 1010, 25000]);
    expect([999, 1005, -1000, "1000", 1000.5].map(parseRewardUse)).toEqual([null, null, null, null, null]);
    expect(rewardUseLimit({ itemsSubtotal: 5000, shippingFee: 3000, couponDiscount: 0, couponIsShipping: false })).toBe(5000);
    expect(rewardUseLimit({ itemsSubtotal: 5000, shippingFee: 3000, couponDiscount: 1000, couponIsShipping: false })).toBe(4000);
    expect(rewardUseLimit({ itemsSubtotal: 5000, shippingFee: 3000, couponDiscount: 3000, couponIsShipping: true })).toBe(4999);
    expect(rewardUseLimit({ itemsSubtotal: 5000, shippingFee: 0, couponDiscount: 0, couponIsShipping: false })).toBe(4999);
  });

  it("반환: 취소·전액 환불은 전부, 부분 환불은 비율(1원 미만 버림)", () => {
    expect(rewardReturnAmount({ rewardUsedAmount: 3000, totalAmount: 5000 })).toBe(3000);
    expect(rewardReturnAmount({ rewardUsedAmount: 3000, totalAmount: 5000, refundAmount: 5000 })).toBe(3000);
    expect(rewardReturnAmount({ rewardUsedAmount: 3000, totalAmount: 7000, refundAmount: 2000 })).toBe(857); // 857.14…
    expect(rewardReturnAmount({ rewardUsedAmount: 0, totalAmount: 7000, refundAmount: 2000 })).toBe(0);
  });
});

describe("주문할 때 적립금 사용", () => {
  it("잔액을 빼고 USE 원장을 남기며, 결제 금액 = 상품 + 배송비 − 적립금이고 카드 결제 시작 금액도 같다", async () => {
    const s = await shop();
    const r = await s.order(3000);
    expect(r).toEqual({ ok: true, orderId: expect.any(String), orderNo: 1, totalAmount: 5000 + 3000 - 3000, shippingFee: 3000 });
    if (!r.ok) return;
    expect(await db.order.findUniqueOrThrow({ where: { id: r.orderId } })).toMatchObject({ rewardUsedAmount: 3000, totalAmount: 5000 });
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(7000);
    expect(await db.rewardLedger.findMany({ where: { orderId: r.orderId } })).toEqual([
      expect.objectContaining({ type: "USE", amount: -3000, status: "SUCCEEDED", idempotencyKey: `use:${r.orderId}` }),
    ]);
    const p = await startPayment(db, new FakePaymentGateway(), { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: r.orderId });
    expect(p).toMatchObject({ ok: true, amount: 5000 });
  });

  it("형식이 틀리거나, 판매자 실지급이 꺼졌거나, 한도·잔액을 넘으면 주문을 만들지 않고 잔액도 그대로", async () => {
    const s = await shop({ balance: 4000 });
    for (const v of [999, 1005, -1000, "1000"]) expect(await s.order(v), String(v)).toEqual({ ok: false, reason: "invalid_reward_use" });
    expect(await s.order(5010)).toEqual({ ok: false, reason: "reward_use_over_limit" }); // 상품 5,000원 초과(배송비에 쓸 수 없음)
    expect(await s.order(4010)).toEqual({ ok: false, reason: "reward_balance_insufficient" });
    expect(await db.order.count()).toBe(0);
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(4000);
    const off = await shop({ live: false });
    expect(await off.order(1000)).toEqual({ ok: false, reason: "reward_use_unavailable" });
    expect(await off.order(0)).toMatchObject({ ok: true });
  });

  it("무료 배송이면 결제할 금액이 1원 이상 남도록 상품 금액 전부는 쓸 수 없다", async () => {
    const s = await shop({ freeShipping: true });
    expect(await s.order(5000)).toEqual({ ok: false, reason: "reward_use_over_limit" });
    expect(await s.order(4990)).toMatchObject({ ok: true, totalAmount: 10 });
  });

  it("동시에 두 주문이 잔액을 넘게 쓰려 하면 하나만 되고 잔액은 음수가 되지 않는다", async () => {
    const s = await shop({ balance: 5000 });
    const rs = await Promise.all([s.order(3000), s.order(3000), s.order(3000)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(["reward_balance_insufficient", "reward_balance_insufficient"]);
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(2000);
    expect(await db.rewardLedger.count({ where: { type: "USE" } })).toBe(1);
  });
});

describe("쓴 적립금 반환", () => {
  it("판매자가 결제 대기 주문을 취소하면 전부 돌려주고, 다시 취소해도 두 번 돌려주지 않는다", async () => {
    const s = await shop();
    const r = await s.order(3000);
    if (!r.ok) throw new Error(r.reason);
    expect(await cancelPendingOrder(db, s.ctx, r.orderId, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) })).toMatchObject({ ok: true });
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(10000);
    expect(await cancelPendingOrder(db, s.ctx, r.orderId, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) })).toMatchObject({ ok: false });
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(10000);
    expect(await db.rewardLedger.findMany({ where: { orderId: r.orderId }, orderBy: { amount: "asc" }, select: { amount: true, idempotencyKey: true } })).toEqual([
      { amount: -3000, idempotencyKey: `use:${r.orderId}` },
      { amount: 3000, idempotencyKey: `use_return:${r.orderId}` },
    ]);
  });

  it("입금 기한 자동 취소도 전부 돌려준다", async () => {
    const s = await shop();
    const r = await s.order(2000);
    if (!r.ok) throw new Error(r.reason);
    await db.order.update({ where: { id: r.orderId }, data: { paymentDueAt: new Date(Date.now() - 1000) } });
    expect((await cancelOverdueOrders(db)).cancelled).toEqual([r.orderId]);
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(10000);
    expect(await cancelOverdueOrders(db)).toMatchObject({ cancelled: [] });
    expect(await db.rewardLedger.count({ where: { orderId: r.orderId, amount: { gt: 0 } } })).toBe(1);
  });

  it("전액 환불은 전부, 발송 뒤 구매자 사정 부분 환불은 환불액 비율만큼(1원 미만 버림) 돌려준다", async () => {
    const s = await shop();
    const full = await s.order(3000);
    if (!full.ok) throw new Error(full.reason);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: full.orderId, paymentMethod: "CARD" });
    expect(await refundOrder(db, s.ctx, full.orderId, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) })).toMatchObject({ ok: true, value: { refundAmount: 5000 } });
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(10000);

    // 상품 5,000 × 2 + 배송비 3,000 − 적립금 3,000 = 결제 10,000원. 발송 뒤 구매자 사정: 상품 10,000 − 반품 배송비 → 환불액 < 결제액
    const part = await s.order(3000, 2);
    if (!part.ok) throw new Error(part.reason);
    expect(part.totalAmount).toBe(10000);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: part.orderId, paymentMethod: "CARD" });
    expect(await shipOrder(db, s.ctx, part.orderId, { courier: "CJ", trackingNumber: "123456789012" })).toMatchObject({ ok: true });
    const before = await balanceOf(s.seller.id, s.buyer.id);
    const rr = await refundOrder(db, s.ctx, part.orderId, { reason: "단순 변심", fault: "BUYER", expectedLiveVersion: await lv(s.seller.id) });
    if (!rr.ok) throw new Error(rr.reason);
    const refund = rr.value.refundAmount;
    expect(refund).toBeLessThan(10000);
    expect((await balanceOf(s.seller.id, s.buyer.id)) - before).toBe(Math.floor((3000 * refund) / 10000));
  });
});
