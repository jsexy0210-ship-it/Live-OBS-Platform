import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as orderRoute } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { markOrderPaid } from "../../lib/server/queue/service";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", priceDelta: 1500, stock: 3 } });
  return { seller, grade, buyer, product, option };
}

async function buyerCookie(sellerId: string, loginId: string) {
  const r = await loginBuyer(db, { sellerId, loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_buyer=${r.token}`;
}

const post = (slug: string, body: unknown, cookie?: string) =>
  orderRoute(
    new Request(`http://localhost:3000/api/shop/${slug}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );

describe("주문 생성", () => {
  it("동의하면 결제 대기 주문을 만들고, 금액은 서버가 계산하며, 동의 시각(DB 시계)·문구 버전을 남긴다. 재고는 빼지 않는다", async () => {
    const s = await shop();
    const r = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: s.option.id, quantity: 2 }], consent });
    expect(r).toEqual({ ok: true, orderId: expect.any(String), orderNo: 1, totalAmount: 13000 });
    if (!r.ok) return;
    const order = await db.order.findUniqueOrThrow({ where: { id: r.orderId }, include: { items: true, consents: true } });
    expect(order).toMatchObject({ status: "PENDING_PAYMENT", totalAmount: 13000, rewardUsedAmount: 0, broadcastNicknameSnapshot: s.buyer.broadcastNickname });
    expect(order.items).toEqual([expect.objectContaining({ unitPrice: 6500, quantity: 2, productNameSnapshot: "부스터 팩", optionNameSnapshot: "1박스" })]);
    expect(order.consents).toEqual([
      expect.objectContaining({ kind: "OPENED_NO_REFUND", noticeVersion: OPENED_NO_REFUND_CONSENT.version, agreedAt: order.createdAt }),
    ]);
    expect((await db.productOption.findUniqueOrThrow({ where: { id: s.option.id } })).stock).toBe(3);
    expect(await db.auditLog.count({ where: { action: "order.create", targetId: r.orderId } })).toBe(1);
  });

  it("동의하지 않으면(체크 해제·값 없음·문자열 true) 주문을 만들지 않고, 문구 버전이 다르면 다시 보여 주게 한다", async () => {
    const s = await shop();
    const base = { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: s.option.id, quantity: 1 }] };
    for (const c of [undefined, { agreed: false, noticeVersion: OPENED_NO_REFUND_CONSENT.version }, { agreed: "true", noticeVersion: OPENED_NO_REFUND_CONSENT.version }]) {
      expect(await createOrder(db, { ...base, consent: c })).toEqual({ ok: false, reason: "consent_required" });
    }
    expect(await createOrder(db, { ...base, consent: { agreed: true, noticeVersion: "old" } })).toEqual({ ok: false, reason: "consent_outdated" });
    expect(await db.order.count()).toBe(0);
    expect(await db.orderConsent.count()).toBe(0);
  });

  it("품절·재고 부족·판매 중 아님·다른 쇼핑몰 옵션·잘못된 품목은 거부", async () => {
    const s = await shop();
    const other = await shop();
    const base = { sellerId: s.seller.id, buyerMemberId: s.buyer.id, consent };
    expect(await createOrder(db, { ...base, items: [{ optionId: s.option.id, quantity: 4 }] })).toEqual({ ok: false, reason: "out_of_stock" });
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 0 } });
    expect(await createOrder(db, { ...base, items: [{ optionId: s.option.id, quantity: 1 }] })).toEqual({ ok: false, reason: "out_of_stock" });
    expect(await createOrder(db, { ...base, items: [{ optionId: other.option.id, quantity: 1 }] })).toEqual({ ok: false, reason: "product_unavailable" });
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 5 } });
    await db.product.update({ where: { id: s.product.id }, data: { status: "HIDDEN" } });
    expect(await createOrder(db, { ...base, items: [{ optionId: s.option.id, quantity: 1 }] })).toEqual({ ok: false, reason: "product_unavailable" });
    for (const items of [[], [{ optionId: s.option.id, quantity: 0 }], [{ optionId: s.option.id, quantity: 100 }], [{ optionId: s.option.id, quantity: 1 }, { optionId: s.option.id, quantity: 1 }], "x"]) {
      expect(await createOrder(db, { ...base, items })).toEqual({ ok: false, reason: "invalid_items" });
    }
    expect(await db.order.count()).toBe(0);
  });

  it("적립금 사용 요청은 무시하지 않고 거부한다(사용 방식 미정)", async () => {
    const s = await shop();
    expect(
      await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: s.option.id, quantity: 1 }], consent, rewardUseAmount: 1000 }),
    ).toEqual({ ok: false, reason: "reward_use_not_supported" });
  });

  it("동시에 주문해도 주문 번호가 겹치지 않는다", async () => {
    const s = await shop();
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 100 } });
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: s.option.id, quantity: 1 }], consent })),
    );
    const nos = rs.map((r) => (r.ok ? r.orderNo : 0)).sort((a, b) => a - b);
    expect(nos).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("마지막 재고에 두 주문이 들어와도(선점 없음) 동시 결제 확인에서 재고는 음수가 되지 않고, 늦은 결제에는 재고 부족 표시가 남는다", async () => {
    const s = await shop();
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 1 } });
    const make = () => createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: s.option.id, quantity: 1 }], consent });
    const [a, b] = [await make(), await make()];
    if (!a.ok || !b.ok) throw new Error("order failed");
    const paid = await Promise.all([
      markOrderPaid(db, { sellerId: s.seller.id, orderId: a.orderId, paymentMethod: "CARD" }),
      markOrderPaid(db, { sellerId: s.seller.id, orderId: b.orderId, paymentMethod: "CARD" }),
    ]);
    expect(paid.map((p) => p.ok && p.value.stockShortage).sort()).toEqual([false, true]);
    expect((await db.productOption.findUniqueOrThrow({ where: { id: s.option.id } })).stock).toBe(0);
    expect(await db.order.count({ where: { status: "PAID", stockShortageAt: { not: null } } })).toBe(1);
  });
});

describe("HTTP: 주문 생성 API", () => {
  it("본문의 금액·단가·주문 상태를 바꿔 보내도 서버 값으로 만든다", async () => {
    const s = await shop();
    const cookie = await buyerCookie(s.seller.id, s.buyer.loginId);
    const res = await post(
      s.seller.slug,
      { items: [{ optionId: s.option.id, quantity: 1, unitPrice: 1 }], consent, totalAmount: 1, status: "PAID", sellerId: "x" },
      cookie,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, totalAmount: 6500 });
    expect(await db.order.findUniqueOrThrow({ where: { id: body.orderId } })).toMatchObject({ totalAmount: 6500, status: "PENDING_PAYMENT", sellerId: s.seller.id });
  });

  it("로그인 안 함·다른 쇼핑몰 세션은 401, 동의 없으면 400", async () => {
    const s = await shop();
    const other = await shop();
    expect((await post(s.seller.slug, { items: [{ optionId: s.option.id, quantity: 1 }], consent })).status).toBe(401);
    const otherCookie = await buyerCookie(other.seller.id, other.buyer.loginId);
    expect((await post(s.seller.slug, { items: [{ optionId: s.option.id, quantity: 1 }], consent }, otherCookie)).status).toBe(401);
    const cookie = await buyerCookie(s.seller.id, s.buyer.loginId);
    const noConsent = await post(s.seller.slug, { items: [{ optionId: s.option.id, quantity: 1 }] }, cookie);
    expect(noConsent.status).toBe(400);
    expect(await noConsent.json()).toEqual({ error: "consent_required" });
  });

  it("잠긴 쇼핑몰은 402와 「지금은 쇼핑몰을 이용할 수 없어요」(판매자 사정은 드러내지 않음)", async () => {
    const s = await shop();
    const cookie = await buyerCookie(s.seller.id, s.buyer.loginId);
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    const res = await post(s.seller.slug, { items: [{ optionId: s.option.id, quantity: 1 }], consent }, cookie);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: "shop_unavailable", message: "지금은 쇼핑몰을 이용할 수 없어요" });
    expect(await db.order.count()).toBe(0);
  });

  it("다른 출처(Origin)에서 온 요청은 403", async () => {
    const s = await shop();
    const cookie = await buyerCookie(s.seller.id, s.buyer.loginId);
    const res = await orderRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://evil.example", cookie },
        body: JSON.stringify({ items: [{ optionId: s.option.id, quantity: 1 }], consent }),
      }),
      { params: Promise.resolve({ slug: s.seller.slug }) },
    );
    expect(res.status).toBe(403);
  });
});
