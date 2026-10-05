import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as previewRoute } from "../../app/api/shop/[slug]/payments/shipping-preview/route";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { SHIPPING_PREVIEW_MESSAGES } from "../../lib/server/payments/messages";
import { previewShipping } from "../../lib/server/payments/shippingPreview";
import { createLoginBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const SEOUL = { zipCode: "06236", address1: "서울 강남구 테헤란로 1" };
const JEJU = { zipCode: "63100", address1: "제주특별자치도 제주시 첨단로 1" };

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", priceDelta: 1500, stock: 50 } });
  return { seller, buyer, product, option };
}

const post = (slug: string, body: unknown) =>
  previewRoute(
    new Request(`http://localhost:3000/api/shop/${slug}/payments/shipping-preview`, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );

describe("배송비 미리보기", () => {
  it("미리보기 금액이 같은 조건으로 만든 주문의 배송비·합계와 같다(기본·무료 기준·도서산간·이벤트 할인)", async () => {
    const s = await shop();
    await db.sellerShippingPolicy.create({ data: { sellerId: s.seller.id, baseFee: 3000, freeOverAmount: 30000, remoteSurcharge: 4000 } });
    await db.product.update({
      where: { id: s.product.id },
      data: { eventDiscountType: "AMOUNT", eventDiscountValue: 500, eventStartsAt: new Date(Date.now() - 3600_000), eventEndsAt: new Date(Date.now() + 3600_000) },
    });
    const cases = [
      { quantity: 2, addr: SEOUL },
      { quantity: 5, addr: SEOUL },
      { quantity: 2, addr: JEJU },
      { quantity: 5, addr: JEJU },
    ];
    for (const c of cases) {
      const items = [{ optionId: s.option.id, quantity: c.quantity }];
      const p = await previewShipping(db, { sellerId: s.seller.id, items, ...c.addr });
      if (!p.ok) throw new Error(p.reason);
      const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items, consent, shippingAddress: { recipientName: "김구매", phone: "01012345678", ...c.addr } });
      if (!o.ok) throw new Error(o.reason);
      expect(p.value, JSON.stringify(c)).toMatchObject({ shippingFee: o.shippingFee, total: o.totalAmount });
    }
    const p = await previewShipping(db, { sellerId: s.seller.id, items: [{ optionId: s.option.id, quantity: 5 }], ...JEJU });
    // 단가 6,500 − 500 = 6,000 × 5 = 30,000(무료 기준 이상) → 기본 배송비 0 + 도서산간 4,000
    expect(p).toEqual({ ok: true, value: { itemsSubtotal: 30000, shippingFee: 4000, isRemote: true, total: 34000 } });
  });

  it("경로: 로그인 없이 계산만 하고, 잘못된 값·판매 중 아님·다른 쇼핑몰 옵션·잠긴 쇼핑몰은 거절", async () => {
    const s = await shop();
    const other = await shop();
    const ok = await post(s.seller.slug, { items: [{ optionId: s.option.id, quantity: 1 }], ...SEOUL });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(await ok.json()).toEqual({ itemsSubtotal: 6500, shippingFee: 3000, isRemote: false, total: 9500 });
    expect(await db.order.count()).toBe(0);

    const bad = await post(s.seller.slug, { items: [{ optionId: s.option.id, quantity: 0 }], ...SEOUL });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_items", message: SHIPPING_PREVIEW_MESSAGES.invalid_items });
    expect((await post(s.seller.slug, { items: [{ optionId: s.option.id, quantity: 1 }], zipCode: "123", address1: "x" })).status).toBe(400);
    expect((await post(s.seller.slug, { items: [{ optionId: other.option.id, quantity: 1 }], ...SEOUL })).status).toBe(409);
    await db.product.update({ where: { id: s.product.id }, data: { status: "DRAFT" } });
    expect((await post(s.seller.slug, { items: [{ optionId: s.option.id, quantity: 1 }], ...SEOUL })).status).toBe(409);
    await db.seller.update({ where: { id: other.seller.id }, data: { status: "SUSPENDED" } });
    expect((await post(other.seller.slug, { items: [{ optionId: other.option.id, quantity: 1 }], ...SEOUL })).status).toBe(402);
  });
});
