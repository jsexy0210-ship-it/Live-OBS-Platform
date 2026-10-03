import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as eventDelete, PUT as eventPut } from "../../app/api/seller/products/[productId]/event/route";
import { GET as productsRoute } from "../../app/api/seller/products/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES } from "../../lib/server/orders/messages";
import { createOption, createProduct, updateOption, updateProduct } from "../../lib/server/products/manage";
import { rewardBase } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };
const HOUR = 60 * 60 * 1000;
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const r = await createProduct(db, ctx, { name: "부스터 팩", price: 10000, status: "ON_SALE", options: [{ name: "기본", stock: 100 }, { name: "프리미엄", priceDelta: 500, stock: 100 }] });
  if (!r.ok) throw new Error(r.reason);
  const [base, premium] = r.value.options;
  const order = async (optionId: string, quantity = 1) => {
    const o = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId, quantity }], consent, shippingAddress: addr });
    if (!o.ok) throw new Error(o.reason);
    return db.order.findUniqueOrThrow({ where: { id: o.orderId }, include: { items: true } });
  };
  return { seller, ctx, productId: r.value.id, base: base.id, premium: premium.id, order, cookie: await cookieOf(owner.email) };
}

const put = (cookie: string, productId: string, body: unknown) =>
  eventPut(new Request(`http://localhost:3000/api/seller/products/${productId}/event`, { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }), {
    params: Promise.resolve({ productId }),
  });
const del = (cookie: string, productId: string) =>
  eventDelete(new Request(`http://localhost:3000/api/seller/products/${productId}/event`, { method: "DELETE", headers: { ...H, cookie } }), { params: Promise.resolve({ productId }) });

describe("이벤트 할인 주문 금액", () => {
  it("기간 안 주문은 할인 뒤 단가(옵션 추가금 포함 단가에 적용, 원 단위 버림)로 만들고 정가를 남기며, 적립 기준도 할인 뒤 금액이다", async () => {
    const s = await shop();
    const r = await put(s.cookie, s.productId, { type: "RATE", value: 10, startsAt: iso(-HOUR), endsAt: iso(2 * HOUR) });
    expect(r.status).toBe(200);
    expect((await r.json()).event).toMatchObject({ type: "RATE", value: 10, active: true, discountedPrice: 9000 });
    const o = await s.order(s.premium, 2);
    expect(o.items[0]).toMatchObject({ unitPrice: 9450, listUnitPrice: 10500, quantity: 2 });
    expect(o.totalAmount).toBe(9450 * 2 + 3000);
    expect(rewardBase(o.items, 0)).toBe(18900);
    expect(await db.auditLog.count({ where: { action: "product.event_set", targetId: s.productId } })).toBe(1);
  });

  it("시작 전·끝난 뒤·끈 뒤에는 정가이고, 이미 만든 주문 금액은 기간이 끝나도 그대로다", async () => {
    const s = await shop();
    expect((await put(s.cookie, s.productId, { type: "AMOUNT", value: 3000, startsAt: iso(HOUR), endsAt: iso(2 * HOUR) })).status).toBe(200);
    expect((await s.order(s.base)).items[0]).toMatchObject({ unitPrice: 10000, listUnitPrice: 10000 });
    // 지금 진행 중으로 바꿔 주문
    await db.product.update({ where: { id: s.productId }, data: { eventStartsAt: new Date(Date.now() - HOUR) } });
    const during = await s.order(s.base);
    expect(during.items[0]).toMatchObject({ unitPrice: 7000, listUnitPrice: 10000 });
    // 끝난 뒤(종료 시각이 지남)
    await db.product.update({ where: { id: s.productId }, data: { eventStartsAt: new Date(Date.now() - 3 * HOUR), eventEndsAt: new Date(Date.now() - HOUR) } });
    expect((await s.order(s.base)).items[0].unitPrice).toBe(10000);
    expect((await db.orderItem.findFirstOrThrow({ where: { orderId: during.id } })).unitPrice).toBe(7000);
    // 끄면 정가, 기록 남김
    await db.product.update({ where: { id: s.productId }, data: { eventStartsAt: new Date(Date.now() - HOUR), eventEndsAt: new Date(Date.now() + HOUR) } });
    expect((await del(s.cookie, s.productId)).status).toBe(200);
    expect((await s.order(s.base)).items[0].unitPrice).toBe(10000);
    expect(await db.auditLog.count({ where: { action: "product.event_clear", targetId: s.productId } })).toBe(1);
  });
});

describe("이벤트 할인 설정 검증", () => {
  it("할인율 1~90%·할인 금액 1원 이상·기간(종료 > 시작, 종료 > 지금, 1년 안) 밖이면 400과 문구, 할인 뒤 단가가 1원 미만이면 거부", async () => {
    const s = await shop();
    const period = { startsAt: iso(-HOUR), endsAt: iso(HOUR) };
    for (const body of [{ type: "RATE", value: 0, ...period }, { type: "RATE", value: 91, ...period }, { type: "RATE", value: "10", ...period }, { type: "FREE", value: 10, ...period }, { type: "AMOUNT", value: 1.5, ...period }]) {
      const r = await put(s.cookie, s.productId, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_event", message: ORDER_ERROR_MESSAGES.invalid_event });
    }
    for (const p of [
      { startsAt: iso(HOUR), endsAt: iso(HOUR) },
      { startsAt: iso(-2 * HOUR), endsAt: iso(-HOUR) },
      { startsAt: iso(0), endsAt: iso(366 * 24 * HOUR) },
      { startsAt: "내일", endsAt: iso(HOUR) },
    ]) {
      const r = await put(s.cookie, s.productId, { type: "RATE", value: 10, ...p });
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe("invalid_event_period");
    }
    const tooLow = await put(s.cookie, s.productId, { type: "AMOUNT", value: 10000, ...period });
    expect(tooLow.status).toBe(400);
    expect(await tooLow.json()).toEqual({ error: "event_price_too_low", message: ORDER_ERROR_MESSAGES.event_price_too_low });
    expect((await db.product.findUniqueOrThrow({ where: { id: s.productId } })).eventDiscountType).toBeNull();
  });

  it("할인이 걸린 상품은 가격·옵션 추가금을 바꿔 할인 뒤 단가가 1원 미만이 되면 거부한다(옵션 추가도)", async () => {
    const s = await shop();
    expect((await put(s.cookie, s.productId, { type: "AMOUNT", value: 9000, startsAt: iso(HOUR), endsAt: iso(2 * HOUR) })).status).toBe(200);
    expect(await updateProduct(db, s.ctx, s.productId, { price: 9000 })).toEqual({ ok: false, reason: "event_price_too_low" });
    expect(await updateOption(db, s.ctx, s.productId, s.base, { priceDelta: -1000 })).toEqual({ ok: false, reason: "event_price_too_low" });
    expect(await createOption(db, s.ctx, s.productId, { name: "할인 옵션", priceDelta: -1500, stock: 1 })).toEqual({ ok: false, reason: "event_price_too_low" });
    expect((await updateProduct(db, s.ctx, s.productId, { price: 9001 })).ok).toBe(true);
    // DB도 넷 다 있거나 넷 다 없는 것만 받는다
    await expect(db.product.update({ where: { id: s.productId }, data: { eventEndsAt: null } })).rejects.toThrow();
  });

  it("상품 목록·응답에 진행 중 여부·할인가·배지를 주고, 다른 쇼핑몰 상품은 404, 상품 권한 없는 직원은 403", async () => {
    const s = await shop();
    await put(s.cookie, s.productId, { type: "RATE", value: 20, startsAt: iso(-HOUR), endsAt: iso(3 * HOUR) });
    const list = await (await productsRoute(new Request("http://localhost:3000/api/seller/products", { headers: { ...H, cookie: s.cookie } }))).json();
    expect(list.products[0].event).toMatchObject({ active: true, discountedPrice: 8000, discountRate: 20 });
    expect(list.products[0].event.remainingLabel).toMatch(/^[23]시간 \d+분 남았어요$/);
    const other = await shop();
    expect((await put(other.cookie, s.productId, { type: "RATE", value: 10, startsAt: iso(-HOUR), endsAt: iso(HOUR) })).status).toBe(404);
    expect((await put(s.cookie, "not-a-uuid", { type: "RATE", value: 10, startsAt: iso(-HOUR), endsAt: iso(HOUR) })).status).toBe(404);
    const staff = await createSellerUser(s.seller.id, { permissions: [] });
    expect((await put(await cookieOf(staff.email), s.productId, { type: "RATE", value: 10, startsAt: iso(-HOUR), endsAt: iso(HOUR) })).status).toBe(403);
    expect((await del(await cookieOf(staff.email), s.productId)).status).toBe(403);
  });
});
