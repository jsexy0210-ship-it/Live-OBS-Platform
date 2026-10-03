import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as deleteRoute, PATCH as patchRoute } from "../../app/api/shop/[slug]/addresses/[addressId]/route";
import { GET as listRoute, POST as createRoute } from "../../app/api/shop/[slug]/addresses/route";
import { POST as orderRoute } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { MAX_BUYER_ADDRESSES } from "../../lib/server/buyers/addresses";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { ORDER_ERROR_MESSAGES } from "../../lib/server/orders/messages";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const home = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "서울 강남구 테헤란로 1", address2: "101호" };
const office = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "04524", address1: "서울 중구 세종대로 110", address2: null };
const nth = (i: number) => ({ ...home, address2: `${i}호` });

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const other = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", priceDelta: 0, stock: 100 } });
  return { seller, buyer, other, option, cookie: await cookieOf(seller.id, buyer.loginId), otherCookie: await cookieOf(seller.id, other.loginId) };
}

async function cookieOf(sellerId: string, loginId: string) {
  const r = await loginBuyer(db, { sellerId, loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_buyer=${r.token}`;
}

const req = (url: string, method: string, cookie?: string, body?: unknown, origin = true) =>
  new Request(`http://localhost:3000${url}`, {
    method,
    headers: { "content-type": "application/json", host: "localhost:3000", ...(origin ? { origin: "http://localhost:3000" } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const slugParams = (slug: string) => ({ params: Promise.resolve({ slug }) });
const idParams = (slug: string, addressId: string) => ({ params: Promise.resolve({ slug, addressId }) });

const list = (slug: string, cookie?: string) => listRoute(req(`/api/shop/${slug}/addresses`, "GET", cookie), slugParams(slug));
const create = (slug: string, cookie: string | undefined, body: unknown, origin = true) => createRoute(req(`/api/shop/${slug}/addresses`, "POST", cookie, body, origin), slugParams(slug));
const patch = (slug: string, cookie: string, id: string, body: unknown) => patchRoute(req(`/api/shop/${slug}/addresses/${id}`, "PATCH", cookie, body), idParams(slug, id));
const remove = (slug: string, cookie: string, id: string) => deleteRoute(req(`/api/shop/${slug}/addresses/${id}`, "DELETE", cookie), idParams(slug, id));
const order = (slug: string, cookie: string, optionId: string, shippingAddress: unknown, extra: Record<string, unknown> = {}) =>
  orderRoute(req(`/api/shop/${slug}/orders`, "POST", cookie, { items: [{ optionId, quantity: 1 }], consent, shippingAddress, ...extra }), slugParams(slug));

const addressesOf = (buyerMemberId: string) => db.buyerAddress.findMany({ where: { buyerMemberId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });

describe("주문 때 배송지 저장", () => {
  it("기본으로 저장하고 첫 배송지는 기본 배송지가 된다. 같은 배송지는 다시 저장하지 않고, saveAddress: false면 저장하지 않는다", async () => {
    const s = await shop();
    expect((await order(s.seller.slug, s.cookie, s.option.id, { ...home, memo: "문 앞" })).status).toBe(200);
    expect(await addressesOf(s.buyer.id)).toEqual([
      expect.objectContaining({ recipientName: "김구매", phone: "01012345678", zipCode: "06236", address2: "101호", memo: "문 앞", label: null, isDefault: true }),
    ]);
    // 같은 배송지(메모만 다름)는 그대로 하나
    expect((await order(s.seller.slug, s.cookie, s.option.id, { ...home, memo: "경비실" })).status).toBe(200);
    expect(await addressesOf(s.buyer.id)).toHaveLength(1);
    // 저장을 끄면 주문만 만든다
    expect((await order(s.seller.slug, s.cookie, s.option.id, office, { saveAddress: false })).status).toBe(200);
    expect(await addressesOf(s.buyer.id)).toHaveLength(1);
    // 두 번째 배송지는 기본이 아니다
    expect((await order(s.seller.slug, s.cookie, s.option.id, office)).status).toBe(200);
    expect((await addressesOf(s.buyer.id)).map((a) => [a.zipCode, a.isDefault])).toEqual([["06236", true], ["04524", false]]);
    // 잘못된 값이면 주문을 만들지 않는다
    const bad = await order(s.seller.slug, s.cookie, s.option.id, home, { saveAddress: "no" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_shipping_address", message: ORDER_ERROR_MESSAGES.invalid_shipping_address });
    expect(await db.order.count({ where: { buyerMemberId: s.buyer.id } })).toBe(4);
  });

  it("20개가 차 있으면 주문은 그대로 만들고 배송지는 더 저장하지 않는다. 실패한 주문은 저장하지 않는다", async () => {
    const s = await shop();
    for (let i = 0; i < MAX_BUYER_ADDRESSES; i++) expect((await create(s.seller.slug, s.cookie, nth(i))).status).toBe(201);
    expect((await order(s.seller.slug, s.cookie, s.option.id, office)).status).toBe(200);
    expect(await db.buyerAddress.count({ where: { buyerMemberId: s.buyer.id } })).toBe(MAX_BUYER_ADDRESSES);
    expect(await db.buyerAddress.count({ where: { buyerMemberId: s.buyer.id, zipCode: "04524" } })).toBe(0);
    // 재고 부족으로 실패한 주문의 배송지는 남기지 않는다
    const t = await shop();
    await db.productOption.update({ where: { id: t.option.id }, data: { stock: 0 } });
    expect((await order(t.seller.slug, t.cookie, t.option.id, office)).status).toBe(400);
    expect(await addressesOf(t.buyer.id)).toEqual([]);
  });
});

describe("배송지 관리 API", () => {
  it("추가·목록·수정·기본 지정이 본인 배송지에만 되고, 응답은 캐시하지 않는다", async () => {
    const s = await shop();
    const a = await create(s.seller.slug, s.cookie, { ...home, label: "집" });
    expect(a.status).toBe(201);
    expect(a.headers.get("cache-control")).toBe("no-store");
    const first = (await a.json()).address;
    expect(first).toMatchObject({ label: "집", phone: "01012345678", isDefault: true });
    const second = (await (await create(s.seller.slug, s.cookie, { ...office, label: "회사", isDefault: true })).json()).address;
    expect(second.isDefault).toBe(true);
    // 기본 배송지는 하나만
    const r = await list(s.seller.slug, s.cookie);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect((await r.json()).addresses.map((x: { label: string; isDefault: boolean }) => [x.label, x.isDefault])).toEqual([["회사", true], ["집", false]]);
    // 보낸 항목만 바꾸고, 기본 지정을 옮긴다
    const p = await patch(s.seller.slug, s.cookie, first.id, { label: "본가", isDefault: true });
    expect(p.status).toBe(200);
    expect((await p.json()).address).toMatchObject({ label: "본가", address2: "101호", isDefault: true });
    expect((await addressesOf(s.buyer.id)).filter((x) => x.isDefault).map((x) => x.id)).toEqual([first.id]);
    // 다른 구매자에게는 보이지 않고, 고치거나 지울 수 없다(없는 배송지와 같은 404)
    expect((await (await list(s.seller.slug, s.otherCookie)).json()).addresses).toEqual([]);
    for (const res of [await patch(s.seller.slug, s.otherCookie, first.id, { label: "남의 집" }), await remove(s.seller.slug, s.otherCookie, first.id), await remove(s.seller.slug, s.cookie, "not-a-uuid")]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "address_not_found", message: ORDER_ERROR_MESSAGES.address_not_found });
    }
    expect(await db.buyerAddress.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ label: "본가" });
    // 로그인 안 함 401, 다른 출처 403
    expect((await list(s.seller.slug)).status).toBe(401);
    expect((await create(s.seller.slug, s.cookie, office, false)).status).toBe(403);
  });

  it("잘못된 값·이름 20자 초과·같은 배송지·21번째 배송지는 거부한다", async () => {
    const s = await shop();
    const bad = await create(s.seller.slug, s.cookie, { ...home, zipCode: "123" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("invalid_shipping_address");
    const longLabel = await create(s.seller.slug, s.cookie, { ...home, label: "가".repeat(21) });
    expect(longLabel.status).toBe(400);
    expect(await longLabel.json()).toEqual({ error: "invalid_address_label", message: ORDER_ERROR_MESSAGES.invalid_address_label });
    expect((await create(s.seller.slug, s.cookie, { ...home, label: "가".repeat(20) })).status).toBe(201);
    const dup = await create(s.seller.slug, s.cookie, { ...home, phone: "01012345678", memo: "다른 메모" });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe("duplicate_address");
    // 수정으로 다른 배송지와 같아져도 거부
    const o = (await (await create(s.seller.slug, s.cookie, office)).json()).address;
    const same = await patch(s.seller.slug, s.cookie, o.id, { zipCode: home.zipCode, address1: home.address1, address2: home.address2 });
    expect(same.status).toBe(409);
    for (let i = 2; i < MAX_BUYER_ADDRESSES; i++) expect((await create(s.seller.slug, s.cookie, nth(i))).status).toBe(201);
    const over = await create(s.seller.slug, s.cookie, nth(99));
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: "too_many_addresses", message: ORDER_ERROR_MESSAGES.too_many_addresses });
  });

  it("기본 배송지를 지우면 가장 최근에 저장한 배송지가 기본이 되고, 지난 주문의 배송지는 그대로다", async () => {
    const s = await shop();
    expect((await order(s.seller.slug, s.cookie, s.option.id, home)).status).toBe(200);
    const [def] = await addressesOf(s.buyer.id);
    await create(s.seller.slug, s.cookie, nth(1));
    const latest = (await (await create(s.seller.slug, s.cookie, nth(2))).json()).address;
    const d = await remove(s.seller.slug, s.cookie, def.id);
    expect(d.status).toBe(200);
    expect((await addressesOf(s.buyer.id)).map((x) => [x.id === latest.id, x.isDefault])).toEqual([[false, false], [true, true]]);
    expect(await db.orderShippingAddress.findFirstOrThrow({ where: { order: { buyerMemberId: s.buyer.id } } })).toMatchObject({ address2: "101호" });
    // 마지막 하나까지 지울 수 있다
    for (const x of await addressesOf(s.buyer.id)) expect((await remove(s.seller.slug, s.cookie, x.id)).status).toBe(200);
    expect(await addressesOf(s.buyer.id)).toEqual([]);
  });

  it("동시에 여러 개를 추가해도 20개를 넘지 않고 기본 배송지는 하나다", async () => {
    const s = await shop();
    const rs = await Promise.all(Array.from({ length: 25 }, (_, i) => create(s.seller.slug, s.cookie, { ...nth(i), isDefault: i % 2 === 0 })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(MAX_BUYER_ADDRESSES);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await db.buyerAddress.count({ where: { buyerMemberId: s.buyer.id } })).toBe(MAX_BUYER_ADDRESSES);
    expect(await db.buyerAddress.count({ where: { buyerMemberId: s.buyer.id, isDefault: true } })).toBe(1);
  });
});
