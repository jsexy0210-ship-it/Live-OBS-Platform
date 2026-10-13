import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as removeRoute } from "../../app/api/shop/[slug]/wishlist/[productId]/route";
import { GET as listRoute, POST as addRoute } from "../../app/api/shop/[slug]/wishlist/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { MAX_WISH_ITEMS, WISH_MESSAGES } from "../../lib/server/shop-wish/service";
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

async function product(sellerId: string, name = "부스터 팩", data: Record<string, unknown> = {}, stock = 10) {
  const p = await db.product.create({ data: { sellerId, name, price: 5000, status: "ON_SALE", ...data } });
  await db.productOption.create({ data: { sellerId, productId: p.id, name: "기본", stock } });
  return p;
}

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const other = await createLoginBuyer(seller.id, grade.id);
  return { seller, buyer, other, p: await product(seller.id), cookie: await cookieOf(seller.id, buyer.loginId), otherCookie: await cookieOf(seller.id, other.loginId) };
}

const req = (url: string, method: string, cookie?: string, body?: unknown) =>
  new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p1 = (slug: string) => ({ params: Promise.resolve({ slug }) });
const list = (slug: string, cookie?: string, query = "") => listRoute(req(`/api/shop/${slug}/wishlist${query}`, "GET", cookie), p1(slug));
const add = (slug: string, cookie: string | undefined, productId: unknown) => addRoute(req(`/api/shop/${slug}/wishlist`, "POST", cookie, { productId }), p1(slug));
const remove = (slug: string, cookie: string, productId: string) =>
  removeRoute(req(`/api/shop/${slug}/wishlist/${productId}`, "DELETE", cookie), { params: Promise.resolve({ slug, productId }) });

describe("찜", () => {
  it("로그인 전에는 401", async () => {
    const s = await shop();
    expect((await list(s.seller.slug)).status).toBe(401);
    expect((await add(s.seller.slug, undefined, s.p.id)).status).toBe(401);
  });

  it("찜하고(다시 찜해도 하나), 목록·하트용 id·빼기. 다른 회원에게는 보이지 않는다", async () => {
    const s = await shop();
    const b = await product(s.seller.id, "카드 슬리브");
    expect(await (await add(s.seller.slug, s.cookie, s.p.id)).json()).toEqual({ productId: s.p.id, count: 1 });
    const again = await add(s.seller.slug, s.cookie, s.p.id);
    expect([again.status, (await again.json()).count]).toEqual([200, 1]);
    expect((await add(s.seller.slug, s.cookie, b.id)).status).toBe(201);
    const res = await list(s.seller.slug, s.cookie);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect([body.count, body.items.map((i: { name: string; status: string; price: number }) => [i.name, i.status, i.price])]).toEqual([
      2,
      [["카드 슬리브", "on_sale", 5000], ["부스터 팩", "on_sale", 5000]],
    ]);
    expect((await (await list(s.seller.slug, s.cookie, "?ids=1")).json()).productIds.sort()).toEqual([s.p.id, b.id].sort());
    expect(await (await list(s.seller.slug, s.cookie, `?ids=1&productIds=${b.id},${crypto.randomUUID()}`)).json()).toEqual({ productIds: [b.id] });
    expect((await (await list(s.seller.slug, s.otherCookie)).json()).items).toEqual([]);
    expect((await remove(s.seller.slug, s.otherCookie, s.p.id)).status).toBe(404);
    expect(await (await remove(s.seller.slug, s.cookie, s.p.id)).json()).toEqual({ removed: true, count: 1 });
    expect((await remove(s.seller.slug, s.cookie, s.p.id)).status).toBe(404);
  });

  it("상태·이벤트 가격은 지금 값으로 보여 준다", async () => {
    const s = await shop();
    await add(s.seller.slug, s.cookie, s.p.id);
    const now = Date.now();
    await db.product.update({
      where: { id: s.p.id },
      data: { eventDiscountType: "AMOUNT", eventDiscountValue: 1000, eventStartsAt: new Date(now - 60_000), eventEndsAt: new Date(now + 3_600_000) },
    });
    let item = (await (await list(s.seller.slug, s.cookie)).json()).items[0];
    expect([item.price, item.listPrice, item.status]).toEqual([4000, 5000, "on_sale"]);
    expect([item.eventBadge, item.isLive]).toEqual([expect.any(String), false]);
    await db.productOption.updateMany({ where: { productId: s.p.id }, data: { stock: 0 } });
    expect((await (await list(s.seller.slug, s.cookie)).json()).items[0].status).toBe("sold_out");
    await db.product.update({ where: { id: s.p.id }, data: { status: "HIDDEN" } });
    item = (await (await list(s.seller.slug, s.cookie)).json()).items[0];
    expect(item.status).toBe("unavailable");
  });

  it("잘못된 값·찜할 수 없는 상품·다른 쇼핑몰 상품을 막는다. 품절 상품은 찜할 수 있다", async () => {
    const s = await shop();
    const t = await shop();
    const bad = await add(s.seller.slug, s.cookie, "x");
    expect([bad.status, await bad.json()]).toEqual([400, { error: "invalid_wish_item", message: WISH_MESSAGES.invalid_wish_item }]);
    for (const data of [{ status: "HIDDEN" }, { status: "DRAFT" }, { deletedAt: new Date() }]) {
      const p = await product(s.seller.id, "막힘", data);
      expect((await (await add(s.seller.slug, s.cookie, p.id)).json()).error).toBe("product_unavailable");
    }
    expect((await (await add(s.seller.slug, s.cookie, t.p.id)).json()).error).toBe("product_unavailable");
    const soldOut = await product(s.seller.id, "품절", { status: "SOLD_OUT" }, 0);
    expect((await add(s.seller.slug, s.cookie, soldOut.id)).status).toBe(201);
  });

  it(`회원당 ${MAX_WISH_ITEMS}개까지(동시에 찜해도 넘지 않는다)`, async () => {
    const s = await shop();
    const ids: string[] = [];
    for (let i = 0; i < MAX_WISH_ITEMS - 3; i++) ids.push((await product(s.seller.id, `상품${i}`)).id);
    await db.wishItem.createMany({ data: ids.map((productId) => ({ sellerId: s.seller.id, buyerMemberId: s.buyer.id, productId })) });
    const more = [];
    for (let i = 0; i < 6; i++) more.push((await product(s.seller.id, `추가${i}`)).id);
    const codes = (await Promise.all(more.map((id) => add(s.seller.slug, s.cookie, id)))).map((r) => r.status);
    expect(codes.filter((c) => c === 201)).toHaveLength(3);
    expect(codes.filter((c) => c === 409)).toHaveLength(3);
    expect(await db.wishItem.count({ where: { buyerMemberId: s.buyer.id } })).toBe(MAX_WISH_ITEMS);
  });

  it("쇼핑몰이 잠기면 찜하기는 402, 목록·빼기는 된다", async () => {
    const s = await shop();
    await add(s.seller.slug, s.cookie, s.p.id);
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await add(s.seller.slug, s.cookie, (await product(s.seller.id, "B")).id)).status).toBe(402);
    expect((await list(s.seller.slug, s.cookie)).status).toBe(200);
    expect((await remove(s.seller.slug, s.cookie, s.p.id)).status).toBe(200);
  });

  it("탈퇴하면 찜을 지운다", async () => {
    const s = await shop();
    await add(s.seller.slug, s.cookie, s.p.id);
    await add(s.seller.slug, s.otherCookie, s.p.id);
    expect((await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD })).ok).toBe(true);
    expect(await db.wishItem.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    expect(await db.wishItem.count({ where: { buyerMemberId: s.other.id } })).toBe(1);
  });
});
