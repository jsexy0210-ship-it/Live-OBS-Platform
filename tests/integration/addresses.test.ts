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
    expect(await longLabel.json()).toEqual({ error: "address_label_too_long", message: "배송지 이름은 20자까지 쓸 수 있어요" });
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

  it("기본 배송지를 지우면(주문에 쓴 적 없는 배송지끼리는) 가장 최근에 저장한 배송지가 기본이 되고, 지난 주문의 배송지는 그대로다", async () => {
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

describe("검수 후속(#91)", () => {
  it("배송지가 있으면 기본 배송지는 항상 1개: 기본 배송지를 기본에서 내리면 400, 다른 배송지는 그대로 200", async () => {
    const s = await shop();
    const a = (await (await create(s.seller.slug, s.cookie, home)).json()).address;
    const b = (await (await create(s.seller.slug, s.cookie, office)).json()).address;
    const r = await patch(s.seller.slug, s.cookie, a.id, { isDefault: false });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: "default_address_required", message: "다른 배송지를 기본으로 정해 주세요" });
    expect((await patch(s.seller.slug, s.cookie, b.id, { isDefault: false, label: "회사" })).status).toBe(200);
    expect((await addressesOf(s.buyer.id)).map((x) => [x.id, x.isDefault, x.label])).toEqual([[a.id, true, null], [b.id, false, "회사"]]);
  });

  it("같은 주소라도 받는 분이나 연락처가 다르면 다른 배송지로 저장한다(메모·이름은 비교하지 않음)", async () => {
    const s = await shop();
    for (const addr of [home, { ...home, recipientName: "이받는" }, { ...home, phone: "010-9999-8888" }, { ...home, memo: "다른 메모" }]) {
      expect((await order(s.seller.slug, s.cookie, s.option.id, addr)).status).toBe(200);
    }
    expect((await addressesOf(s.buyer.id)).map((x) => [x.recipientName, x.phone])).toEqual([["김구매", "01012345678"], ["이받는", "01012345678"], ["김구매", "01099998888"]]);
  });

  it("기본 배송지를 지우면 가장 최근에 사용한(주문에 쓴) 배송지가 기본이 된다. 같은 배송지로 다시 주문하면 사용 시각만 바뀐다", async () => {
    const s = await shop();
    const used = (addr: unknown, extra: Record<string, unknown> = {}) => order(s.seller.slug, s.cookie, s.option.id, addr, extra);
    expect((await used(home)).status).toBe(200); // 기본
    expect((await used(office)).status).toBe(200);
    expect((await used(nth(7))).status).toBe(200);
    const officeRow = (await addressesOf(s.buyer.id)).find((x) => x.zipCode === "04524")!;
    // 저장은 가장 늦지만 쓴 적 없는 배송지
    expect((await create(s.seller.slug, s.cookie, nth(8))).status).toBe(201);
    // 회사로 다시 주문(메모만 다름): 새로 저장하지 않고 사용 시각만 바뀐다
    expect((await used({ ...office, memo: "경비실" })).status).toBe(200);
    const after = (await addressesOf(s.buyer.id)).find((x) => x.id === officeRow.id)!;
    expect(after.lastUsedAt!.getTime()).toBeGreaterThan(officeRow.lastUsedAt!.getTime());
    expect(after).toMatchObject({ memo: null, isDefault: false });
    expect(await addressesOf(s.buyer.id)).toHaveLength(4);
    const def = (await addressesOf(s.buyer.id)).find((x) => x.isDefault)!;
    expect((await remove(s.seller.slug, s.cookie, def.id)).status).toBe(200);
    expect((await addressesOf(s.buyer.id)).find((x) => x.isDefault)!.id).toBe(officeRow.id);
  });

  it("[검수 P2] 이름 사유별 문구, isDefault 문자열 거부, 연속 공백은 같은 배송지, 403도 no-store, 빈 수정 400, 주문 저장도 감사 로그", async () => {
    const s = await shop();
    const invisible = await create(s.seller.slug, s.cookie, { ...home, label: "\u200b" });
    expect(invisible.status).toBe(400);
    expect(await invisible.json()).toEqual({ error: "invalid_address_label", message: "배송지 이름을 다시 확인해 주세요" });
    const strDefault = await create(s.seller.slug, s.cookie, { ...home, isDefault: "true" });
    expect(strDefault.status).toBe(400);
    expect(await addressesOf(s.buyer.id)).toEqual([]);
    // 주문으로 저장해도 감사 로그를 남긴다
    expect((await order(s.seller.slug, s.cookie, s.option.id, home)).status).toBe(200);
    const [saved] = await addressesOf(s.buyer.id);
    expect(await db.auditLog.count({ where: { action: "buyer_address.create", targetId: saved.id } })).toBe(1);
    // 주소 안의 연속 공백은 하나로 보고 같은 배송지로 본다
    expect((await order(s.seller.slug, s.cookie, s.option.id, { ...home, address1: "서울  강남구   테헤란로 1", address2: "101호" })).status).toBe(200);
    expect(await addressesOf(s.buyer.id)).toHaveLength(1);
    const dup = await create(s.seller.slug, s.cookie, { ...home, address1: "서울 강남구 테헤란로  1" });
    expect(dup.status).toBe(409);
    // 다른 출처 403도 캐시하지 않는다
    const forbidden = await create(s.seller.slug, s.cookie, office, false);
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("cache-control")).toBe("no-store");
    // 바꿀 항목이 없는 수정은 400이고 감사 로그를 남기지 않는다
    for (const body of [[], {}]) {
      const r = await patch(s.seller.slug, s.cookie, saved.id, body);
      expect(r.status).toBe(400);
    }
    expect(await db.auditLog.count({ where: { action: "buyer_address.update", targetId: saved.id } })).toBe(0);
  });

  it("[Codex P2] 받는 분·주소 등 배송지를 가르는 항목을 고치면 사용 시각을 지우고(이름·메모만 고치면 유지), 길이는 연속 공백을 줄인 값으로 잰다", async () => {
    const s = await shop();
    expect((await order(s.seller.slug, s.cookie, s.option.id, home)).status).toBe(200);
    const [a] = await addressesOf(s.buyer.id);
    expect(a.lastUsedAt).not.toBeNull();
    expect((await patch(s.seller.slug, s.cookie, a.id, { label: "집", memo: "문 앞" })).status).toBe(200);
    expect((await db.buyerAddress.findUniqueOrThrow({ where: { id: a.id } })).lastUsedAt).toEqual(a.lastUsedAt);
    expect((await patch(s.seller.slug, s.cookie, a.id, { zipCode: "04524" })).status).toBe(200);
    expect((await db.buyerAddress.findUniqueOrThrow({ where: { id: a.id } })).lastUsedAt).toBeNull();
    // 공백을 줄이면 200자·30자·100자 안에 드는 값은 받는다(쓸 수 없는 글자는 그대로 거부)
    const spaced = { ...office, recipientName: `김${" ".repeat(40)}구매`, address1: `서울${" ".repeat(250)}중구 세종대로 110`, address2: `1${" ".repeat(120)}층` };
    expect((await order(s.seller.slug, s.cookie, s.option.id, spaced)).status).toBe(200);
    const saved = (await addressesOf(s.buyer.id)).find((x) => x.zipCode === "04524" && x.id !== a.id)!;
    expect(saved).toMatchObject({ recipientName: "김 구매", address1: "서울 중구 세종대로 110", address2: "1 층" });
    expect((await order(s.seller.slug, s.cookie, s.option.id, { ...office, address1: "가".repeat(201) })).status).toBe(400);
    expect((await order(s.seller.slug, s.cookie, s.option.id, { ...office, address1: `서울 \u2028 중구` })).status).toBe(400);
  });
});
