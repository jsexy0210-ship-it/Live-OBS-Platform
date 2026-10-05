import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PATCH as patchRoute } from "../../app/api/shop/[slug]/cart/[itemId]/route";
import { GET as checkoutRoute } from "../../app/api/shop/[slug]/cart/checkout/route";
import { GET as listRoute, POST as addRoute } from "../../app/api/shop/[slug]/cart/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

// 장바구니 변경 표시: 담은 뒤 가격 변경(priceChange)·재고 부족(shortage·maxQuantity·stockLeft)
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const r = await loginBuyer(db, { sellerId: seller.id, loginId: buyer.loginId!, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", priceDelta: 1000, stock: 50 } });
  return { seller, buyer, product, option, cookie: `lo_buyer=${r.token}` };
}
type Shop = Awaited<ReturnType<typeof shop>>;

const req = (url: string, method: string, cookie: string, body?: unknown) =>
  new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const slugP = (slug: string) => ({ params: Promise.resolve({ slug }) });
const add = (s: Shop, optionId = s.option.id, quantity = 1) => addRoute(req(`/api/shop/${s.seller.slug}/cart`, "POST", s.cookie, { optionId, quantity }), slugP(s.seller.slug)).then(async (r) => ({ status: r.status, body: await r.json() }));
const cart = async (s: Shop) => (await (await listRoute(req(`/api/shop/${s.seller.slug}/cart`, "GET", s.cookie), slugP(s.seller.slug))).json()) as { items: any[]; priceChangedCount: number; subtotal: number };
const setQty = (s: Shop, itemId: string, quantity: number) => patchRoute(req(`/api/shop/${s.seller.slug}/cart/${itemId}`, "PATCH", s.cookie, { quantity }), { params: Promise.resolve({ slug: s.seller.slug, itemId }) });

describe("담은 뒤 가격 변경", () => {
  it("담을 때 단가를 기억하고, 같으면 priceChange는 null이다", async () => {
    const s = await shop();
    await add(s);
    const c = await cart(s);
    expect(c.items[0]).toMatchObject({ unitPrice: 6000, priceChange: null });
    expect(c.priceChangedCount).toBe(0);
    expect((await db.cartItem.findFirstOrThrow()).addedUnitPrice).toBe(6000);
  });

  it("가격이 오르면 up, 내리면 down과 차이를 주고, 이벤트 할인이 걸리면 할인가 기준으로 내림으로 본다", async () => {
    const s = await shop();
    await add(s);
    await db.product.update({ where: { id: s.product.id }, data: { price: 5500 } });
    let c = await cart(s);
    expect(c.items[0].priceChange).toEqual({ from: 6000, to: 6500, diff: 500, direction: "up" });
    expect(c.priceChangedCount).toBe(1);
    expect(c.items[0].unitPrice * c.items[0].quantity).toBe(c.items[0].lineTotal); // 금액은 늘 지금 단가
    await db.product.update({ where: { id: s.product.id }, data: { price: 5000, eventDiscountType: "RATE", eventDiscountValue: 10, eventStartsAt: new Date(Date.now() - 3600_000), eventEndsAt: new Date(Date.now() + 3600_000) } });
    c = await cart(s);
    expect(c.items[0].priceChange).toEqual({ from: 6000, to: 5400, diff: -600, direction: "down" });
  });

  it("수량을 바꾸면 비교 기준이 지금 단가로 새로 맞춰지고, 같은 옵션을 다시 담아도 마찬가지다", async () => {
    const s = await shop();
    const { body } = await add(s);
    await db.product.update({ where: { id: s.product.id }, data: { price: 5500 } });
    expect((await cart(s)).items[0].priceChange).not.toBeNull();
    expect((await setQty(s, body.item.id, 2)).status).toBe(200);
    expect((await cart(s)).items[0]).toMatchObject({ priceChange: null, unitPrice: 6500 });
    await db.product.update({ where: { id: s.product.id }, data: { price: 5000 } });
    expect((await cart(s)).items[0].priceChange).toMatchObject({ from: 6500, to: 6000 });
    await add(s); // 다시 담기: 수량 합산 + 기준 갱신
    expect((await cart(s)).items[0]).toMatchObject({ quantity: 3, priceChange: null });
  });

  it("담을 때 단가가 없는 이전 줄은 priceChange가 null이고, 살 수 없는 줄은 수량을 줄여도 기준을 바꾸지 않는다", async () => {
    const s = await shop();
    const { body } = await add(s, s.option.id, 2);
    await db.cartItem.update({ where: { id: body.item.id }, data: { addedUnitPrice: null } });
    await db.product.update({ where: { id: s.product.id }, data: { price: 9000 } });
    expect((await cart(s)).items[0].priceChange).toBeNull();
    await db.cartItem.update({ where: { id: body.item.id }, data: { addedUnitPrice: 6000 } });
    await db.product.update({ where: { id: s.product.id }, data: { status: "HIDDEN" } });
    expect((await setQty(s, body.item.id, 1)).status).toBe(200); // 줄이기는 안 팔아도 된다
    expect((await db.cartItem.findFirstOrThrow()).addedUnitPrice).toBe(6000);
    expect((await cart(s)).items[0]).toMatchObject({ status: "unavailable", maxQuantity: 0, shortage: 0, stockLeft: null });
  });

  it("주문서로 넘길 때 줄(lines)에도 같은 표시가 들어간다", async () => {
    const s = await shop();
    const { body } = await add(s, s.option.id, 1);
    const res = await checkoutRoute(req(`/api/shop/${s.seller.slug}/cart/checkout?ids=${body.item.id}`, "GET", s.cookie), slugP(s.seller.slug));
    const out = await res.json();
    expect(out.lines[0]).toMatchObject({ priceChange: null, maxQuantity: 50, shortage: 0, stockLeft: null });
  });
});

describe("재고 표시", () => {
  it("재고가 모자라면 shortage·maxQuantity를, 적을 때만 stockLeft를 준다", async () => {
    const s = await shop();
    const { body } = await add(s, s.option.id, 4);
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 3 } });
    expect((await cart(s)).items[0]).toMatchObject({ status: "not_enough_stock", quantity: 4, stock: 3, maxQuantity: 3, shortage: 1, stockLeft: 3 });
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 4 } });
    expect((await cart(s)).items[0]).toMatchObject({ status: "available", maxQuantity: 4, shortage: 0, stockLeft: 4 });
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 6 } });
    expect((await cart(s)).items[0]).toMatchObject({ maxQuantity: 6, shortage: 0, stockLeft: null }); // 6개부터는 남은 수를 알리지 않는다
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 500 } });
    expect((await cart(s)).items[0].maxQuantity).toBe(99); // 주문 한도
    expect(body.item.id).toBeTruthy();
  });

  it("품절·재고 0·판매 중지는 maxQuantity 0이고 shortage·stockLeft는 비어 있다", async () => {
    const s = await shop();
    await add(s, s.option.id, 2);
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 0 } });
    expect((await cart(s)).items[0]).toMatchObject({ status: "sold_out", maxQuantity: 0, shortage: 0, stockLeft: null });
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 9 } });
    await db.product.update({ where: { id: s.product.id }, data: { status: "SOLD_OUT" } });
    expect((await cart(s)).items[0]).toMatchObject({ status: "sold_out", maxQuantity: 0 });
  });
});
