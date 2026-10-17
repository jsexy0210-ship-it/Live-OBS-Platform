import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as addRoute } from "../../app/api/shop/[slug]/cart/route";
import { GET as profileRoute } from "../../app/api/shop/[slug]/me/profile/route";
import { PUT as legalRoute } from "../../app/api/seller/shop-legal-notice/route";
import { POST as orderRoute } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { createSellerSession } from "../../lib/server/auth/session";
import { isMinor } from "../../lib/server/buyers/minor";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const shippingAddress = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "서울 강남구 테헤란로 1", address2: "101호" };
const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const dateOnly = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("만 19세 미만 판정(한국 날짜)", () => {
  it("19번째 생일 당일부터 성인이다. 하루 전은 미성년", () => {
    const now = new Date("2026-10-17T03:00:00Z"); // KST 2026-10-17 12:00
    expect(isMinor(dateOnly("2007-10-17"), now)).toBe(false);
    expect(isMinor(dateOnly("2007-10-18"), now)).toBe(true);
    expect(isMinor(dateOnly("1990-01-01"), now)).toBe(false);
  });
  it("한국 날짜 기준: UTC로는 전날이어도 KST 자정 뒤면 생일이 지난 것으로 본다. 2월 29일 생일은 평년 3월 1일에 성인", () => {
    expect(isMinor(dateOnly("2007-10-17"), new Date("2026-10-16T15:30:00Z"))).toBe(false); // KST 10-17 00:30
    expect(isMinor(dateOnly("2008-02-29"), new Date("2027-02-28T03:00:00Z"))).toBe(true);
    expect(isMinor(dateOnly("2008-02-29"), new Date("2027-03-01T03:00:00Z"))).toBe(false);
  });
});

async function shop(opts: { policy?: "BLOCK" | "NOTICE"; birthDate?: string | null } = {}) {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  if (opts.birthDate !== undefined) await db.buyerMember.update({ where: { id: buyer.id }, data: { birthDate: opts.birthDate ? dateOnly(opts.birthDate) : null } });
  if (opts.policy) await db.shopLegalNotice.create({ data: { sellerId: seller.id, minorPolicy: opts.policy, version: 1 } });
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", priceDelta: 0, stock: 5 } });
  const r = await loginBuyer(db, { sellerId: seller.id, loginId: buyer.loginId, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return { seller, buyer, option, cookie: `lo_buyer=${r.token}` };
}
const placeOrder = (s: Awaited<ReturnType<typeof shop>>) => createOrder(db, { shippingAddress, sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: s.option.id, quantity: 1 }], consent });
const addCart = (s: Awaited<ReturnType<typeof shop>>) =>
  addRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/cart`, { method: "POST", headers: { ...H, cookie: s.cookie }, body: JSON.stringify({ optionId: s.option.id, quantity: 1 }) }), { params: Promise.resolve({ slug: s.seller.slug }) });

describe("미성년자 구매 막기 — 주문·장바구니", () => {
  it("기본(고지 후 허용)이거나 정책 행이 없으면 만 19세 미만도 주문·담기 가능", async () => {
    const none = await shop({ birthDate: "2015-01-01" });
    expect((await placeOrder(none)).ok).toBe(true);
    expect((await addCart(none)).status).toBe(201);
    const notice = await shop({ policy: "NOTICE", birthDate: "2015-01-01" });
    expect((await placeOrder(notice)).ok).toBe(true);
  });

  it("막는 쇼핑몰: 만 19세 미만은 주문 거절(주문 없음), 장바구니 담기도 403 minor_blocked. 성인은 가능", async () => {
    const minor = await shop({ policy: "BLOCK", birthDate: "2015-01-01" });
    expect(await placeOrder(minor)).toEqual({ ok: false, reason: "minor_blocked" });
    expect(await db.order.count({ where: { sellerId: minor.seller.id } })).toBe(0);
    const cart = await addCart(minor);
    expect([cart.status, (await cart.json()).error]).toEqual([403, "minor_blocked"]);
    const adult = await shop({ policy: "BLOCK", birthDate: "1990-05-05" });
    expect((await placeOrder(adult)).ok).toBe(true);
    expect((await addCart(adult)).status).toBe(201);
  });

  it("막는 쇼핑몰에서 생년월일이 없는 회원은 identity_reverify_required(403), 주문 HTTP도 403", async () => {
    const s = await shop({ policy: "BLOCK", birthDate: null });
    expect(await placeOrder(s)).toEqual({ ok: false, reason: "identity_reverify_required" });
    const res = await orderRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, {
        method: "POST",
        headers: { ...H, cookie: s.cookie },
        body: JSON.stringify({ items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress }),
      }),
      { params: Promise.resolve({ slug: s.seller.slug }) },
    );
    expect([res.status, (await res.json()).error]).toEqual([403, "identity_reverify_required"]);
  });

  it("내 정보에 minorPurchase{policy, blocked, reverifyRequired}가 나온다", async () => {
    const read = async (s: Awaited<ReturnType<typeof shop>>) =>
      (await profileRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/me/profile`, { headers: { cookie: s.cookie } }), { params: Promise.resolve({ slug: s.seller.slug }) })).json();
    expect((await read(await shop({ birthDate: "2015-01-01" }))).minorPurchase).toEqual({ policy: "notice", blocked: false, reverifyRequired: false });
    expect((await read(await shop({ policy: "BLOCK", birthDate: "2015-01-01" }))).minorPurchase).toEqual({ policy: "block", blocked: true, reverifyRequired: false });
    expect((await read(await shop({ policy: "BLOCK", birthDate: null }))).minorPurchase).toEqual({ policy: "block", blocked: false, reverifyRequired: true });
    expect((await read(await shop({ policy: "BLOCK", birthDate: "1990-05-05" }))).minorPurchase).toEqual({ policy: "block", blocked: false, reverifyRequired: false });
  });
});

describe("미성년자 구매 정책 저장(PUT /api/seller/shop-legal-notice)", () => {
  async function seller() {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    return { seller, cookie: `lo_seller=${(await createSellerSession(db, seller.id, owner.id, {}, owner.credentialVersion)).token}` };
  }
  const put = (cookie: string, body: unknown) => legalRoute(new Request("http://localhost:3000/api/seller/shop-legal-notice", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));

  it("block으로 저장하고, 빼면 지금 값을 유지하며, 틀린 값은 400 invalid_minor_policy", async () => {
    const s = await seller();
    const saved = await put(s.cookie, { minorPolicy: "block", expectedVersion: 0 });
    expect(saved.status).toBe(200);
    expect((await saved.json()).notice).toMatchObject({ minorPolicy: "block", version: 1 });
    const kept = await put(s.cookie, { address: "서울", expectedVersion: 1 });
    expect((await kept.json()).notice).toMatchObject({ minorPolicy: "block", address: "서울", version: 2 });
    const bad = await put(s.cookie, { minorPolicy: "maybe", expectedVersion: 2 });
    expect([bad.status, (await bad.json()).error]).toEqual([400, "invalid_minor_policy"]);
    const back = await put(s.cookie, { minorPolicy: "notice", expectedVersion: 2 });
    expect((await back.json()).notice.minorPolicy).toBe("notice");
    expect(await db.shopLegalNotice.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).toMatchObject({ minorPolicy: "NOTICE", version: 3 });
  });
});
