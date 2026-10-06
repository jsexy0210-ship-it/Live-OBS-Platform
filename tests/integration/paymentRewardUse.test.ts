import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { cancelOverdueOrders } from "../../lib/server/orders/overdue";
import { shipOrder } from "../../lib/server/orders/ship";
import { FakePaymentGateway } from "../../lib/server/payments/gateway";
import { quoteOrder } from "../../lib/server/orders/quote";
import { parseRewardUse, rewardReturnAmount, rewardUseLimit } from "../../lib/server/payments/rewardUse";
import { startPayment } from "../../lib/server/payments/service";
import { cancelPendingOrder, markOrderPaid, previewRefund, refundOrder } from "../../lib/server/queue/service";
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
async function shop(opts: { balance?: number; live?: boolean; freeShipping?: boolean; useMinAmount?: number; useMaxRatio?: number } = {}) {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock: 100 } });
  await db.rewardPolicy.create({ data: { sellerId: seller.id, livePayoutEnabled: opts.live ?? true, ...(opts.useMinAmount !== undefined ? { useMinAmount: opts.useMinAmount } : {}), ...(opts.useMaxRatio !== undefined ? { useMaxRatio: opts.useMaxRatio } : {}) } });
  await db.rewardBalance.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, balance: opts.balance ?? 10000 } });
  if (opts.freeShipping) await db.sellerShippingPolicy.create({ data: { sellerId: seller.id, freeShipping: true } });
  const quote = (rewardUseAmount: unknown, quantity = 1) =>
    quoteOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity }], couponId: undefined, rewardUseAmount, zipCode: "06236", address1: "서울 강남구 테헤란로 1" });
  const order = (rewardUseAmount: unknown, quantity = 1) =>
    createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity }], consent, shippingAddress, rewardUseAmount });
  return { seller, owner, ctx, buyer, option, order, quote };
}

const balanceOf = async (sellerId: string, buyerMemberId: string) =>
  (await db.rewardBalance.findUniqueOrThrow({ where: { sellerId_buyerMemberId: { sellerId, buyerMemberId } } })).balance;
const lv = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;

describe("적립금 사용 규칙(계산)", () => {
  it("1,000원 이상 10원 단위, 한도는 상품 금액(상품 쿠폰 뺀 값)이고 결제할 금액이 1원 이상 남는다", () => {
    expect([undefined, null, 0].map(parseRewardUse)).toEqual([0, 0, 0]);
    expect([1000, 1010, 25000].map(parseRewardUse)).toEqual([1000, 1010, 25000]);
    expect(parseRewardUse(10)).toBe(10); // 쇼핑몰 최소 금액은 설정을 읽은 뒤 확인(형식은 10원 단위만)
    expect([999, 1005, -1000, "1000", 1000.5].map(parseRewardUse)).toEqual([null, null, null, null, null]);
    expect(rewardUseLimit({ itemsSubtotal: 5000, shippingFee: 3000, couponDiscount: 0, couponIsShipping: false })).toBe(5000);
    expect(rewardUseLimit({ itemsSubtotal: 5000, shippingFee: 3000, couponDiscount: 1000, couponIsShipping: false })).toBe(4000);
    expect(rewardUseLimit({ itemsSubtotal: 5000, shippingFee: 3000, couponDiscount: 3000, couponIsShipping: true })).toBe(4999);
    expect(rewardUseLimit({ itemsSubtotal: 5000, shippingFee: 0, couponDiscount: 0, couponIsShipping: false })).toBe(4999);
  });

  it("주문당 최대 비율: 상품 금액(상품 쿠폰 뺀 값) × 비율 ÷ 100을 10원 단위로 내리고, 0·100은 비율 제한 없음", () => {
    const o = { itemsSubtotal: 5000, shippingFee: 3000, couponDiscount: 0, couponIsShipping: false };
    expect(rewardUseLimit({ ...o, maxRatio: 0 })).toBe(5000);
    expect(rewardUseLimit({ ...o, maxRatio: 100 })).toBe(5000);
    expect(rewardUseLimit({ ...o, maxRatio: 50 })).toBe(2500);
    expect(rewardUseLimit({ ...o, maxRatio: 33 })).toBe(1650);
    expect(rewardUseLimit({ ...o, itemsSubtotal: 5010, maxRatio: 33 })).toBe(1650); // 1653.3 → 10원 단위 내림
    expect(rewardUseLimit({ ...o, maxRatio: 1 })).toBe(50);
    expect(rewardUseLimit({ ...o, itemsSubtotal: 999, maxRatio: 1 })).toBe(0); // 9.99 → 0
    // 상품 쿠폰을 뺀 금액이 기준, 기존 한도(결제 1원 이상)가 더 작으면 그쪽
    expect(rewardUseLimit({ ...o, couponDiscount: 1000, maxRatio: 50 })).toBe(2000);
    expect(rewardUseLimit({ ...o, shippingFee: 0, maxRatio: 100 })).toBe(4999);
    expect(rewardUseLimit({ ...o, shippingFee: 0, maxRatio: 99 })).toBe(4950);
  });

  it("반환: 취소·상품 전부 환불은 전부, 일부 상품 환불은 상품 금액 비율로 10원 단위 내림", () => {
    expect(rewardReturnAmount({ rewardUsedAmount: 3000 })).toBe(3000);
    expect(rewardReturnAmount({ rewardUsedAmount: 3010, items: { refunded: 12000, ordered: 12000 } })).toBe(3010); // 전부면 끝수까지 전부
    expect(rewardReturnAmount({ rewardUsedAmount: 3010, items: { refunded: 5000, ordered: 12000 } })).toBe(1250); // 1254.16… → 1250
    expect(rewardReturnAmount({ rewardUsedAmount: 3000, items: { refunded: 2000, ordered: 7000 } })).toBe(850); // 857.14… → 850
    expect(rewardReturnAmount({ rewardUsedAmount: 3000, items: { refunded: 0, ordered: 7000 } })).toBe(0);
    expect(rewardReturnAmount({ rewardUsedAmount: 0, items: { refunded: 2000, ordered: 7000 } })).toBe(0);
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
    expect(await db.rewardLedger.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { orderId: r.orderId } })).toEqual([
      expect.objectContaining({ type: "USE", amount: -3000, status: "SUCCEEDED", idempotencyKey: `use:${r.orderId}` }),
    ]);
    const p = await startPayment(db, new FakePaymentGateway(), { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: r.orderId });
    expect(p).toMatchObject({ ok: true, amount: 5000 });
  });

  it("형식이 틀리거나, 판매자 실지급이 꺼졌거나, 한도·잔액을 넘으면 주문을 만들지 않고 잔액도 그대로", async () => {
    const s = await shop({ balance: 4000 });
    for (const v of [999, 1005, -1000, "1000"]) expect(await s.order(v), String(v)).toEqual({ ok: false, reason: "invalid_reward_use" });
    expect(await s.order(5010)).toEqual({ ok: false, reason: "reward_use_over_limit" }); // 상품 5,000원 초과(배송비에 쓸 수 없음)
    expect(await s.order(100000)).toEqual({ ok: false, reason: "reward_use_over_limit" }); // 결제 금액이 음수가 될 만큼 넘어도 500이 아니라 한도 초과
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

describe("쇼핑몰별 적립금 사용 조건(최소 금액·최대 비율)", () => {
  it("설정을 바꾸지 않은 쇼핑몰은 예전과 같다: 최소 1,000원, 비율 제한 없음", async () => {
    const s = await shop();
    expect(await s.order(990)).toEqual({ ok: false, reason: "invalid_reward_use" });
    expect(await s.order(1000)).toMatchObject({ ok: true });
    const q = await s.quote(0);
    expect(q.ok && q.value.rewardMax).toBe(5000);
  });

  it("최소 사용 금액: 미만은 invalid_reward_use, 경계값(같음)은 통과, 10원 단위가 아니면 형식 오류", async () => {
    const s = await shop({ useMinAmount: 3000, balance: 20000 });
    expect(await s.order(2990)).toEqual({ ok: false, reason: "invalid_reward_use" });
    expect(await s.order(10)).toEqual({ ok: false, reason: "invalid_reward_use" });
    expect(await s.order(3005)).toEqual({ ok: false, reason: "invalid_reward_use" });
    expect(await s.order(3000)).toMatchObject({ ok: true });
    expect(await s.order(3010)).toMatchObject({ ok: true });
    const low = await shop({ useMinAmount: 10 });
    expect(await low.order(10)).toMatchObject({ ok: true });
    // 견적도 같은 판단
    const q = await s.quote(2990);
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.reason).toBe("invalid_reward_use");
    expect((await s.quote(3000)).ok).toBe(true);
  });

  it("최소 금액이 한도·잔액보다 크면 견적의 rewardMax는 0이다", async () => {
    const s = await shop({ useMinAmount: 6000, balance: 20000 }); // 상품 5,000원이라 6,000원은 못 씀
    const q = await s.quote(0);
    expect(q.ok && q.value.rewardMax).toBe(0);
    const poor = await shop({ useMinAmount: 3000, balance: 2000 });
    const q2 = await poor.quote(0);
    expect(q2.ok && q2.value.rewardMax).toBe(0);
  });

  it("주문당 최대 비율: 한도 = 상품 금액 × 비율, 경계값(같음)은 통과·10원 초과는 reward_use_over_limit, 견적 rewardMax도 같다", async () => {
    const s = await shop({ useMaxRatio: 50, balance: 20000 });
    const q = await s.quote(0);
    expect(q.ok && q.value.rewardMax).toBe(2500);
    expect(await s.order(2510)).toEqual({ ok: false, reason: "reward_use_over_limit" });
    expect(await s.order(2500)).toMatchObject({ ok: true, totalAmount: 5000 + 3000 - 2500 });
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(17500);
    // 수량 2개면 상품 금액이 10,000원이라 한도 5,000원
    const q2 = await s.quote(0, 2);
    expect(q2.ok && q2.value.rewardMax).toBe(5000);
    expect(await s.order(5010, 2)).toEqual({ ok: false, reason: "reward_use_over_limit" });
    expect(await s.order(5000, 2)).toMatchObject({ ok: true });
  });

  it("비율 한도가 최소 금액보다 작으면 쓸 수 없고(rewardMax 0), 비율 0은 제한 없음", async () => {
    const s = await shop({ useMaxRatio: 10, useMinAmount: 1000 }); // 한도 500원 < 최소 1,000원
    const q = await s.quote(0);
    expect(q.ok && q.value.rewardMax).toBe(0);
    expect(await s.order(500)).toEqual({ ok: false, reason: "invalid_reward_use" });
    expect(await s.order(1000)).toEqual({ ok: false, reason: "reward_use_over_limit" });
    const none = await shop({ useMaxRatio: 0 });
    expect(await none.order(5000)).toMatchObject({ ok: true });
  });

  it("견적과 주문 생성은 같은 금액에서 같은 결과를 낸다(최소 금액·비율 조합)", async () => {
    const s = await shop({ useMinAmount: 2000, useMaxRatio: 60, balance: 100000 });
    for (const amount of [0, 1990, 2000, 2990, 3000, 3010, 4000]) {
      const q = await s.quote(amount);
      const o = await s.order(amount);
      expect(q.ok, String(amount)).toBe(o.ok);
      if (!q.ok && !o.ok) expect(q.reason, String(amount)).toBe(o.reason);
    }
  });

  it("바꾼 설정은 다음 주문부터 적용된다: 비율을 줄이면 이미 만든 주문은 그대로, 새 주문은 새 한도", async () => {
    const s = await shop({ useMaxRatio: 100, balance: 20000 });
    const a = await s.order(4000);
    expect(a).toMatchObject({ ok: true });
    await db.rewardPolicy.update({ where: { sellerId: s.seller.id }, data: { useMaxRatio: 40 } });
    expect(await s.order(4000)).toEqual({ ok: false, reason: "reward_use_over_limit" });
    expect(await s.order(2000)).toMatchObject({ ok: true });
    if (a.ok) expect(await db.order.findUniqueOrThrow({ where: { id: a.orderId } })).toMatchObject({ rewardUsedAmount: 4000 });
  });

  it("동시성: 비율 한도 안에서 여러 주문이 동시에 와도 잔액이 음수가 되지 않고 한도를 넘는 주문은 없다", async () => {
    const s = await shop({ useMaxRatio: 50, balance: 6000 });
    const rs = await Promise.all([s.order(2500), s.order(2500), s.order(2500), s.order(2510)]);
    expect(rs[3]).toEqual({ ok: false, reason: "reward_use_over_limit" });
    expect(rs.slice(0, 3).filter((r) => r.ok)).toHaveLength(2); // 잔액 6,000원: 2,500원 두 번만
    expect(rs.slice(0, 3).filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(["reward_balance_insufficient"]);
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(1000);
    expect(await db.rewardLedger.count({ where: { type: "USE" } })).toBe(2);
  });

  it("동시성: 설정을 바꾸는 동안 주문이 와도 어느 주문도 이전·이후 한도 중 큰 값을 넘지 않고 잔액은 맞는다", async () => {
    const s = await shop({ useMaxRatio: 100, balance: 50000 });
    const upd = db.rewardPolicy.update({ where: { sellerId: s.seller.id }, data: { useMaxRatio: 20, useMinAmount: 500 } });
    const rs = await Promise.all([upd, s.order(1000), s.order(1000), s.order(5000), s.order(1000)]);
    const orders = rs.slice(1) as Awaited<ReturnType<typeof s.order>>[];
    // 5,000원(이전 한도 100%에서만 가능)은 되거나 안 되거나, 되면 이전 설정으로 읽은 것
    const used = await db.order.aggregate({ _sum: { rewardUsedAmount: true } });
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(50000 - (used._sum.rewardUsedAmount ?? 0));
    for (const o of orders) if (o.ok) expect((await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).rewardUsedAmount).toBeLessThanOrEqual(5000);
    // 이후(커밋된 뒤) 주문은 새 한도 1,000원(상품 5,000원의 20%)만 쓴다
    expect(await s.order(1010)).toEqual({ ok: false, reason: "reward_use_over_limit" });
    expect(await s.order(1000)).toMatchObject({ ok: true });
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

  it("전액 환불은 전부, 상품을 모두 돌려받는 구매자 사정 환불(반품 배송비 차감)도 전부 돌려준다", async () => {
    const s = await shop();
    const full = await s.order(3000);
    if (!full.ok) throw new Error(full.reason);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: full.orderId, paymentMethod: "CARD" });
    expect(await refundOrder(db, s.ctx, full.orderId, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) })).toMatchObject({ ok: true, value: { refundAmount: 5000 } });
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(10000);

    const shipped = await s.order(3010, 2);
    if (!shipped.ok) throw new Error(shipped.reason);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: shipped.orderId, paymentMethod: "CARD" });
    expect(await shipOrder(db, s.ctx, shipped.orderId, { courier: "CJ", trackingNumber: "123456789012" })).toMatchObject({ ok: true });
    const rr = await refundOrder(db, s.ctx, shipped.orderId, { reason: "단순 변심", fault: "BUYER", expectedLiveVersion: await lv(s.seller.id) });
    if (!rr.ok) throw new Error(rr.reason);
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(10000); // 상품은 전부 돌아왔으므로 적립금은 전부
    // 불변식: 현금 + 적립금 반환(3,010) = 돌아오는 상품 10,000 − 반품 배송비(처음 배송비는 돌려주지 않음)
    expect(rr.value.refundAmount + 3010).toBe(10000 - rr.value.returnFeeDeducted);
  });

  it("개봉한 품목을 구매자가 갖는 부분 환불은 돌려주는 상품 금액 비율로 10원 단위 내림", async () => {
    const s = await shop();
    const product2 = await db.product.create({ data: { sellerId: s.seller.id, name: "박스", price: 7000, status: "ON_SALE" } });
    const option2 = await db.productOption.create({ data: { sellerId: s.seller.id, productId: product2.id, name: "1박스", stock: 10 } });
    // 상품 5,000 + 7,000 = 12,000 + 배송비 3,000 − 적립금 3,010 = 결제 11,990
    const r = await createOrder(db, {
      sellerId: s.seller.id,
      buyerMemberId: s.buyer.id,
      items: [{ optionId: s.option.id, quantity: 1 }, { optionId: option2.id, quantity: 1 }],
      consent,
      shippingAddress,
      rewardUseAmount: 3010,
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.totalAmount).toBe(11990);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: r.orderId, paymentMethod: "CARD" });
    // 7,000원 품목은 개봉을 마쳐 구매자가 갖는다 → 5,000원 품목만 돌아온다
    const opened = await db.orderItem.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { orderId: r.orderId, optionId: option2.id } });
    await db.queueItem.updateMany({ where: { orderItemId: opened.id }, data: { status: "DONE", openingStartedAt: new Date() } });
    expect(await shipOrder(db, s.ctx, r.orderId, { courier: "CJ", trackingNumber: "123456789012" })).toMatchObject({ ok: true });
    const before = await balanceOf(s.seller.id, s.buyer.id);
    // 화면 미리보기도 같은 금액(expectedRefundAmount로 넘기는 값)
    const preview = await previewRefund(db, s.ctx, r.orderId);
    expect(preview?.byFault.BUYER).toMatchObject({ rewardReturn: 1250 });
    const rr = await refundOrder(db, s.ctx, r.orderId, {
      reason: "단순 변심",
      fault: "BUYER",
      confirmOpened: true,
      expectedRefundAmount: preview!.byFault.BUYER.refundAmount,
      expectedLiveVersion: await lv(s.seller.id),
    });
    if (!rr.ok) throw new Error(rr.reason);
    // 3,010 × 5,000 ÷ 12,000 = 1,254.16… → 1,250. 현금은 그만큼 덜 돌려준다(검수 #346 반례: 5,000원 상품에 6,250원을 돌려주면 안 됨).
    expect((await balanceOf(s.seller.id, s.buyer.id)) - before).toBe(1250);
    const fee = rr.value.returnFeeDeducted;
    expect(fee).toBeGreaterThan(0);
    expect(rr.value.refundAmount).toBe(5000 - 1250 - fee);
    // 불변식: 현금 환불 + 적립금 반환 = 돌아오는 상품 금액 − 반품 배송비
    expect(rr.value.refundAmount + 1250).toBe(5000 - fee);
    expect(await db.rewardLedger.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { idempotencyKey: `use_return:${r.orderId}` } })).toMatchObject({ amount: 1250, status: "SUCCEEDED" });
  });
});
