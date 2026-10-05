import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as quotePost } from "../../app/api/shop/[slug]/orders/quote/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

// 주문서 견적(POST /api/shop/{slug}/orders/quote): 주문 생성과 같은 계산(쿠폰 → 적립금, 결제 금액 최소 1원), 읽기 전용, 판매자 격리.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const shippingAddress = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };
const DAY = 86_400_000;

async function shop(price = 30000) {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const r = await loginBuyer(db, { sellerId: seller.id, loginId: buyer.loginId!, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 박스", price, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 50 } });
  return { seller, buyer, option, cookie: `lo_buyer=${r.token}` };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const quote = async (s: Shop, body: Record<string, unknown>, cookie: string | null = s.cookie, slug = s.seller.slug) => {
  const res = await quotePost(
    new Request(`${BASE}/api/shop/${slug}/orders/quote`, { method: "POST", headers: { ...H, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ slug }) },
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
};
const items = (s: Shop, quantity = 1) => [{ optionId: s.option.id, quantity }];

async function giveCoupon(s: Shop, value: number, extra: Record<string, unknown> = {}) {
  const coupon = await db.coupon.create({
    data: { sellerId: s.seller.id, name: "쿠폰", issueMethod: "DOWNLOAD", benefit: "AMOUNT", value, startsAt: new Date(Date.now() - DAY), endsAt: new Date(Date.now() + 10 * DAY), ...extra },
  });
  await db.buyerCoupon.create({ data: { sellerId: s.seller.id, couponId: coupon.id, buyerMemberId: s.buyer.id, issuedAt: new Date(), expiresAt: coupon.endsAt } });
  return coupon;
}
const giveReward = async (s: Shop, balance: number) => {
  await db.rewardPolicy.upsert({ where: { sellerId: s.seller.id }, create: { sellerId: s.seller.id, livePayoutEnabled: true }, update: { livePayoutEnabled: true } });
  await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, balance } });
};

describe("주문서 견적", () => {
  it("쿠폰·적립금 없이 상품 금액과 배송비, 결제 금액을 준다", async () => {
    const s = await shop();
    const r = await quote(s, { items: items(s, 2) });
    expect(r.status).toBe(200);
    expect(r.body.itemsSubtotal).toBe(60000);
    expect(r.body.couponDiscount).toBe(0);
    expect(r.body.totalAmount).toBe(60000 + r.body.shippingFee);
    expect(r.body.coupon).toBeNull();
    expect(r.body.rewardMax).toBe(0);
  });

  it("쿠폰을 먼저 빼고 적립금은 그다음이며, 견적 금액이 실제 주문 금액과 같다", async () => {
    const s = await shop();
    const c = await giveCoupon(s, 5000);
    await giveReward(s, 20000);
    const q = await quote(s, { items: items(s), couponId: c.id, rewardUseAmount: 3000 });
    expect(q.status).toBe(200);
    expect(q.body.couponDiscount).toBe(5000);
    expect(q.body.items[0].couponDiscount).toBe(5000);
    expect(q.body.rewardUse).toBe(3000);
    expect(q.body.totalAmount).toBe(30000 + q.body.shippingFee - 5000 - 3000);
    // 쓸 수 있는 최대: 상품 금액 − 상품 쿠폰 = 25,000, 잔액 20,000 이하
    expect(q.body.rewardMax).toBe(20000);
    const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: items(s), consent, shippingAddress, couponId: c.id, rewardUseAmount: 3000 });
    expect(o.ok && o.totalAmount).toBe(q.body.totalAmount);
  });

  it("결제 금액은 최소 1원이다: 한도를 넘는 적립금은 거부하고 한도까지는 허용한다", async () => {
    const s = await shop(10000);
    const c = await giveCoupon(s, 4000);
    await giveReward(s, 100000);
    const limit = (await quote(s, { items: items(s), couponId: c.id })).body.rewardMax as number;
    expect(limit).toBe(6000); // 상품 금액 10,000 − 쿠폰 4,000
    const over = await quote(s, { items: items(s), couponId: c.id, rewardUseAmount: limit + 10 });
    expect(over.status).toBe(400);
    expect(over.body.error).toBe("reward_use_over_limit");
    const ok = await quote(s, { items: items(s), couponId: c.id, rewardUseAmount: limit });
    expect(ok.body.totalAmount).toBe(ok.body.shippingFee);
  });

  it("쿠폰 할인은 상품 금액을 넘지 않고(배송비는 남음), 잔액보다 큰 적립금은 거부한다", async () => {
    const s = await shop(10000);
    const big = await giveCoupon(s, 9_000_000);
    const capped = await quote(s, { items: items(s), couponId: big.id });
    expect(capped.status).toBe(200);
    expect(capped.body.couponDiscount).toBe(10000);
    expect(capped.body.totalAmount).toBe(capped.body.shippingFee);
    expect(capped.body.rewardMax).toBe(0);
    await giveReward(s, 2000);
    const bal = await quote(s, { items: items(s), rewardUseAmount: 3000 });
    expect(bal.body.error).toBe("reward_balance_insufficient");
    expect((await quote(s, { items: items(s), rewardUseAmount: 1235 })).body.error).toBe("invalid_reward_use");
  });

  it("견적은 쿠폰·적립금·재고를 바꾸지 않는다", async () => {
    const s = await shop();
    const c = await giveCoupon(s, 5000);
    await giveReward(s, 20000);
    await quote(s, { items: items(s), couponId: c.id, rewardUseAmount: 3000 });
    expect((await db.buyerCoupon.findFirstOrThrow({ where: { couponId: c.id } })).status).toBe("ISSUED");
    expect((await db.rewardBalance.findFirstOrThrow({ where: { sellerId: s.seller.id } })).balance).toBe(20000);
    expect(await db.order.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect((await db.productOption.findUniqueOrThrow({ where: { id: s.option.id } })).stock).toBe(50);
  });

  it("다른 판매자의 옵션·쿠폰·쇼핑몰은 쓸 수 없고, 로그인이 없으면 401이다", async () => {
    const a = await shop();
    const b = await shop();
    const foreignOption = await quote(a, { items: items(b) });
    expect(foreignOption.status).toBe(400);
    expect(foreignOption.body.error).toBe("product_unavailable");
    const foreignCoupon = await giveCoupon(b, 5000);
    const r = await quote(a, { items: items(a), couponId: foreignCoupon.id });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("coupon_unavailable");
    // A 구매자 세션으로 B 쇼핑몰 견적은 로그인 없음으로 본다
    expect((await quote(a, { items: items(b) }, a.cookie, b.seller.slug)).status).toBe(401);
    expect((await quote(a, { items: items(a) }, null)).status).toBe(401);
  });

  it("품목이 잘못되면 400, 재고가 모자라면 out_of_stock이다", async () => {
    const s = await shop();
    expect((await quote(s, { items: [] })).body.error).toBe("invalid_items");
    expect((await quote(s, { items: items(s, 51) })).body.error).toBe("out_of_stock");
  });
});
