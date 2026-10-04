import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as deleteItemRoute, PATCH as patchRoute } from "../../app/api/shop/[slug]/cart/[itemId]/route";
import { GET as checkoutRoute } from "../../app/api/shop/[slug]/cart/checkout/route";
import { GET as countRoute } from "../../app/api/shop/[slug]/cart/count/route";
import { DELETE as deleteRoute, GET as listRoute, POST as addRoute } from "../../app/api/shop/[slug]/cart/route";
import { POST as orderRoute } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { CART_MESSAGES, MAX_CART_ITEMS } from "../../lib/server/shop-cart/service";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function cookieOf(sellerId: string, loginId: string) {
  const r = await loginBuyer(db, { sellerId, loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_buyer=${r.token}`;
}

async function product(sellerId: string, name = "부스터 팩", price = 5000, stock = 10, data: Record<string, unknown> = {}) {
  const p = await db.product.create({ data: { sellerId, name, price, status: "ON_SALE", ...data } });
  const o = await db.productOption.create({ data: { sellerId, productId: p.id, name: "1박스", priceDelta: 1000, stock } });
  return { product: p, option: o };
}

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const other = await createLoginBuyer(seller.id, grade.id);
  const a = await product(seller.id);
  return { seller, buyer, other, a, cookie: await cookieOf(seller.id, buyer.loginId), otherCookie: await cookieOf(seller.id, other.loginId) };
}

const req = (url: string, method: string, cookie?: string, body?: unknown) =>
  new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p1 = (slug: string) => ({ params: Promise.resolve({ slug }) });
const p2 = (slug: string, itemId: string) => ({ params: Promise.resolve({ slug, itemId }) });

const list = (slug: string, cookie?: string) => listRoute(req(`/api/shop/${slug}/cart`, "GET", cookie), p1(slug));
const add = (slug: string, cookie: string | undefined, body: unknown) => addRoute(req(`/api/shop/${slug}/cart`, "POST", cookie, body), p1(slug));
const patch = (slug: string, cookie: string, id: string, body: unknown) => patchRoute(req(`/api/shop/${slug}/cart/${id}`, "PATCH", cookie, body), p2(slug, id));
const removeOne = (slug: string, cookie: string, id: string) => deleteItemRoute(req(`/api/shop/${slug}/cart/${id}`, "DELETE", cookie), p2(slug, id));
const removeMany = (slug: string, cookie: string, itemIds: unknown) => deleteRoute(req(`/api/shop/${slug}/cart`, "DELETE", cookie, { itemIds }), p1(slug));
const count = (slug: string, cookie?: string) => countRoute(req(`/api/shop/${slug}/cart/count`, "GET", cookie), p1(slug));
const checkout = (slug: string, cookie: string, ids: string[]) => checkoutRoute(req(`/api/shop/${slug}/cart/checkout?ids=${ids.join(",")}`, "GET", cookie), p1(slug));

describe("장바구니 담기·목록", () => {
  it("로그인 전에는 401, 개수는 0", async () => {
    const s = await shop();
    expect((await list(s.seller.slug)).status).toBe(401);
    expect((await add(s.seller.slug, undefined, { optionId: s.a.option.id })).status).toBe(401);
    expect(await (await count(s.seller.slug)).json()).toEqual({ count: 0 });
  });

  it("담고, 같은 옵션은 수량을 더하고, 목록·개수·금액을 지금 값으로 준다", async () => {
    const s = await shop();
    const b = await product(s.seller.id, "카드 슬리브", 3000, 5);
    const r1 = await add(s.seller.slug, s.cookie, { optionId: s.a.option.id, quantity: 2 });
    expect(r1.status).toBe(201);
    const { item } = await r1.json();
    expect(await (await add(s.seller.slug, s.cookie, { optionId: s.a.option.id })).json()).toEqual({ item: { id: item.id, quantity: 3 }, count: 1 });
    expect((await add(s.seller.slug, s.cookie, { optionId: b.option.id, quantity: 1 })).status).toBe(201);
    const res = await list(s.seller.slug, s.cookie);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.items.map((i: { productName: string; quantity: number; unitPrice: number; status: string }) => [i.productName, i.quantity, i.unitPrice, i.status])).toEqual([
      ["카드 슬리브", 1, 4000, "available"],
      ["부스터 팩", 3, 6000, "available"],
    ]);
    expect(body.subtotal).toBe(4000 + 18000);
    expect(await (await count(s.seller.slug, s.cookie)).json()).toEqual({ count: 2 });
    // 다른 회원에게는 보이지 않는다
    expect((await (await list(s.seller.slug, s.otherCookie)).json()).items).toEqual([]);
  });

  it("이벤트 할인 중이면 할인 단가, 상태가 바뀌면 줄 상태가 바뀌고 금액에서 빠진다", async () => {
    const s = await shop();
    const id = (await (await add(s.seller.slug, s.cookie, { optionId: s.a.option.id, quantity: 4 })).json()).item.id;
    const now = Date.now();
    await db.product.update({
      where: { id: s.a.product.id },
      data: { eventDiscountType: "RATE", eventDiscountValue: 10, eventStartsAt: new Date(now - 60_000), eventEndsAt: new Date(now + 3_600_000) },
    });
    let line = (await (await list(s.seller.slug, s.cookie)).json()).items[0];
    expect([line.unitPrice, line.listUnitPrice, line.lineTotal]).toEqual([5400, 6000, 21600]);
    await db.productOption.update({ where: { id: s.a.option.id }, data: { stock: 3 } });
    line = (await (await list(s.seller.slug, s.cookie)).json()).items[0];
    expect([line.status, line.stock]).toEqual(["not_enough_stock", 3]);
    await db.productOption.update({ where: { id: s.a.option.id }, data: { stock: 0 } });
    expect((await (await list(s.seller.slug, s.cookie)).json()).items[0].status).toBe("sold_out");
    await db.product.update({ where: { id: s.a.product.id }, data: { status: "HIDDEN" } });
    const body = await (await list(s.seller.slug, s.cookie)).json();
    expect([body.items[0].id, body.items[0].status, body.subtotal]).toEqual([id, "unavailable", 0]);
  });

  it("잘못된 값·판매 중이 아닌 상품·재고 초과·한도를 막는다", async () => {
    const s = await shop();
    const slug = s.seller.slug;
    for (const bad of [{}, { optionId: "x" }, { optionId: s.a.option.id, quantity: 0 }, { optionId: s.a.option.id, quantity: 100 }, { optionId: s.a.option.id, quantity: 1.5 }]) {
      const r = await add(slug, s.cookie, bad);
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_cart_item", message: CART_MESSAGES.invalid_cart_item });
    }
    expect((await (await add(slug, s.cookie, { optionId: s.a.option.id, quantity: 11 })).json()).error).toBe("out_of_stock");
    const hidden = await product(s.seller.id, "숨김", 1000, 5, { status: "HIDDEN" });
    expect((await (await add(slug, s.cookie, { optionId: hidden.option.id })).json()).error).toBe("product_unavailable");
    const soldOut = await product(s.seller.id, "품절", 1000, 5, { status: "SOLD_OUT" });
    expect((await (await add(slug, s.cookie, { optionId: soldOut.option.id })).json()).error).toBe("out_of_stock");
    const deleted = await product(s.seller.id, "옵션 삭제", 1000, 5);
    await db.productOption.update({ where: { id: deleted.option.id }, data: { deletedAt: new Date() } });
    expect((await (await add(slug, s.cookie, { optionId: deleted.option.id })).json()).error).toBe("product_unavailable");
    const big = await product(s.seller.id, "대량", 1000, 500);
    expect((await add(slug, s.cookie, { optionId: big.option.id, quantity: 99 })).status).toBe(201);
    const over = await add(slug, s.cookie, { optionId: big.option.id, quantity: 1 });
    expect([over.status, (await over.json()).error]).toEqual([409, "quantity_limit"]);
    expect(await db.cartItem.count()).toBe(1);
  });

  it(`회원당 ${MAX_CART_ITEMS}줄까지(동시에 담아도 넘지 않는다)`, async () => {
    const s = await shop();
    const options = [];
    for (let i = 0; i < MAX_CART_ITEMS + 5; i++) options.push((await product(s.seller.id, `상품${i}`)).option);
    const results = await Promise.all(options.map((o) => add(s.seller.slug, s.cookie, { optionId: o.id })));
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(MAX_CART_ITEMS);
    expect(codes.filter((c) => c === 409)).toHaveLength(5);
    expect(await db.cartItem.count({ where: { buyerMemberId: s.buyer.id } })).toBe(MAX_CART_ITEMS);
  });

  it("다른 쇼핑몰 옵션은 담을 수 없고, 다른 쇼핑몰 세션으로는 볼 수 없다", async () => {
    const s = await shop();
    const t = await shop();
    expect((await (await add(s.seller.slug, s.cookie, { optionId: t.a.option.id })).json()).error).toBe("product_unavailable");
    expect((await add(s.seller.slug, s.cookie, { optionId: s.a.option.id })).status).toBe(201);
    expect((await list(t.seller.slug, s.cookie)).status).toBe(401);
  });

  it("쇼핑몰이 잠기면 담기·수량 변경·주문서 넘기기는 402, 목록·삭제는 된다", async () => {
    const s = await shop();
    const id = (await (await add(s.seller.slug, s.cookie, { optionId: s.a.option.id })).json()).item.id;
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await add(s.seller.slug, s.cookie, { optionId: s.a.option.id })).status).toBe(402);
    expect((await patch(s.seller.slug, s.cookie, id, { quantity: 2 })).status).toBe(402);
    expect((await checkout(s.seller.slug, s.cookie, [id])).status).toBe(402);
    expect((await list(s.seller.slug, s.cookie)).status).toBe(200);
    expect((await removeOne(s.seller.slug, s.cookie, id)).status).toBe(200);
  });
});

describe("수량 변경·삭제", () => {
  it("수량을 바꾸고, 늘릴 때만 재고를 본다. 남의 줄은 404", async () => {
    const s = await shop();
    const id = (await (await add(s.seller.slug, s.cookie, { optionId: s.a.option.id, quantity: 5 })).json()).item.id;
    expect(await (await patch(s.seller.slug, s.cookie, id, { quantity: 7 })).json()).toEqual({ item: { id, quantity: 7 } });
    expect((await (await patch(s.seller.slug, s.cookie, id, { quantity: 11 })).json()).error).toBe("out_of_stock");
    expect((await patch(s.seller.slug, s.cookie, id, { quantity: 0 })).status).toBe(400);
    await db.productOption.update({ where: { id: s.a.option.id }, data: { stock: 0 } });
    expect((await patch(s.seller.slug, s.cookie, id, { quantity: 1 })).status).toBe(200);
    expect((await patch(s.seller.slug, s.otherCookie, id, { quantity: 1 })).status).toBe(404);
    expect((await removeOne(s.seller.slug, s.otherCookie, id)).status).toBe(404);
    expect((await patch(s.seller.slug, s.cookie, "not-a-uuid", { quantity: 1 })).status).toBe(404);
  });

  it("한 줄·선택 삭제. 남의 줄은 지우지 않는다", async () => {
    const s = await shop();
    const b = await product(s.seller.id, "B");
    const c = await product(s.seller.id, "C");
    const ids = [];
    for (const o of [s.a.option, b.option, c.option]) ids.push((await (await add(s.seller.slug, s.cookie, { optionId: o.id })).json()).item.id);
    const mine = (await (await add(s.seller.slug, s.otherCookie, { optionId: s.a.option.id })).json()).item.id;
    expect(await (await removeOne(s.seller.slug, s.cookie, ids[0])).json()).toEqual({ removed: 1, count: 2 });
    expect(await (await removeMany(s.seller.slug, s.cookie, [ids[1], ids[2], mine])).json()).toEqual({ removed: 2, count: 0 });
    expect(await db.cartItem.count({ where: { id: mine } })).toBe(1);
    expect((await removeMany(s.seller.slug, s.cookie, [])).status).toBe(400);
    expect((await removeMany(s.seller.slug, s.cookie, "x")).status).toBe(400);
  });
});

describe("주문서로 넘기기", () => {
  it("고른 줄을 주문 items로 주고, 그대로 주문이 만들어진다", async () => {
    const s = await shop();
    const b = await product(s.seller.id, "B", 2000, 5);
    const id1 = (await (await add(s.seller.slug, s.cookie, { optionId: s.a.option.id, quantity: 2 })).json()).item.id;
    const id2 = (await (await add(s.seller.slug, s.cookie, { optionId: b.option.id })).json()).item.id;
    const res = await checkout(s.seller.slug, s.cookie, [id1]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([{ optionId: s.a.option.id, quantity: 2 }]);
    expect(body.subtotal).toBe(12000);
    const order = await orderRoute(
      req(`/api/shop/${s.seller.slug}/orders`, "POST", s.cookie, {
        items: body.items,
        consent: { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version },
        shippingAddress: { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" },
      }),
      p1(s.seller.slug),
    );
    expect(order.status).toBe(200);
    expect(await db.orderItem.findMany({ select: { optionId: true, quantity: true } })).toEqual([{ optionId: s.a.option.id, quantity: 2 }]);
    expect((await checkout(s.seller.slug, s.cookie, [id1, id2])).status).toBe(200);
  });

  it("주문할 수 없는 줄·없는 줄·빈 선택을 막는다", async () => {
    const s = await shop();
    const id = (await (await add(s.seller.slug, s.cookie, { optionId: s.a.option.id, quantity: 3 })).json()).item.id;
    const otherId = (await (await add(s.seller.slug, s.otherCookie, { optionId: s.a.option.id })).json()).item.id;
    expect((await checkout(s.seller.slug, s.cookie, [])).status).toBe(400);
    expect((await checkout(s.seller.slug, s.cookie, [id, id])).status).toBe(400);
    expect((await checkout(s.seller.slug, s.cookie, [otherId])).status).toBe(404);
    await db.productOption.update({ where: { id: s.a.option.id }, data: { stock: 2 } });
    const r = await checkout(s.seller.slug, s.cookie, [id]);
    expect(r.status).toBe(409);
    const body = await r.json();
    expect([body.error, body.message, body.lines.map((l: { id: string; status: string }) => [l.id, l.status])]).toEqual([
      "checkout_unavailable",
      CART_MESSAGES.checkout_unavailable,
      [[id, "not_enough_stock"]],
    ]);
  });
});

describe("회원 탈퇴", () => {
  it("탈퇴하면 장바구니를 지운다", async () => {
    const s = await shop();
    expect((await add(s.seller.slug, s.cookie, { optionId: s.a.option.id })).status).toBe(201);
    expect((await add(s.seller.slug, s.otherCookie, { optionId: s.a.option.id })).status).toBe(201);
    const r = await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD });
    expect(r.ok).toBe(true);
    expect(await db.cartItem.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    expect(await db.cartItem.count({ where: { buyerMemberId: s.other.id } })).toBe(1);
  });
});
