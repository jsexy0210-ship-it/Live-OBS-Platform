import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as adminSearchRoute } from "../../app/api/admin/search/route";
import { GET as sellerSearchRoute } from "../../app/api/seller/search/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createAdmin, createBuyer, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 전역 검색: 마스터는 파트너스·주문번호·결제번호·문의·작업 id(구매자 개인정보는 검색·응답 모두 없음),
// 파트너스는 내 쇼핑몰 안에서만(상품·주문번호·회원 닉네임·내 문의), 권한 없는 종류는 빈 목록, 다른 쇼핑몰은 없는 것과 같다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { host: "localhost:3000" };
const call = (route: (r: Request) => Promise<Response>, q: string | null, cookie: string) =>
  route(new Request(`http://localhost:3000/api/x${q === null ? "" : `?q=${encodeURIComponent(q)}`}`, { headers: { ...H, cookie } }));
async function adminCookie(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "READ_ONLY") {
  const a = await createAdmin(role);
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
async function sellerCookie(sellerId: string, kind: Parameters<typeof createSellerUser>[1]) {
  const u = await createSellerUser(sellerId, kind);
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return { id: u.id, cookie: `lo_seller=${r.token}` };
}
async function shopData(name: string) {
  const { seller, grade } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { shopName: name, slug: `slug-${name}` } });
  const buyer = await createBuyer(seller.id, grade.id);
  await db.buyerMember.update({ where: { id: buyer.id }, data: { broadcastNickname: `단골${name}` } });
  const product = await db.product.create({ data: { sellerId: seller.id, name: `포켓몬카드 ${name}`, price: 1000 } });
  const order = await db.order.create({ data: { sellerId: seller.id, orderNo: 7777, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 10000 } });
  return { seller, buyer, product, order };
}

describe("마스터 검색 GET /api/admin/search", () => {
  it("파트너스·주문번호·결제번호·문의·작업 id를 찾고 처리 화면 주소를 준다. 구매자 이름·연락처로는 찾지 않는다", async () => {
    const plans = await seedPlans();
    const a = await shopData("가나다");
    const b = await shopData("라마바");
    const pay = await db.payment.create({ data: { sellerId: a.seller.id, orderId: a.order.id, provider: "nicepay", method: "CARD", status: "PAID", amount: 10000, pgTid: "TID-ABC-1" } });
    const sub = await db.sellerSubscription.create({ data: { sellerId: a.seller.id, planId: plans.INTEGRATED.id } });
    const subPay = await db.subscriptionPayment.create({ data: { sellerId: a.seller.id, subscriptionId: sub.id, amount: 1000, periodStart: new Date(), periodEnd: new Date(Date.now() + 86_400_000), providerPaymentId: "SUBPAY-1" } });
    const owner = await createSellerUser(a.seller.id, "OWNER");
    const inq = await db.platformInquiry.create({ data: { sellerId: a.seller.id, createdBySellerUserId: owner.id, category: "BILLING", title: "청구서 환불 문의" } });
    const ap = await db.automationPayment.create({ data: { sellerId: b.seller.id, amount: 1000, status: "PAID", idempotencyKey: "k", requestFingerprint: "x", consentNoticeVersion: "x", consentAgreedAt: new Date() } });
    const job = await db.automationJob.create({ data: { sellerId: b.seller.id, obsTargetKey: "obs:b", status: "QUEUED", queuedAt: new Date(), runAfter: new Date(), paymentId: ap.id } });

    const get = async (q: string, role: Parameters<typeof adminCookie>[0] = "READ_ONLY") => {
      const r = await call(adminSearchRoute, q, await adminCookie(role));
      expect(r.status).toBe(200);
      expect(r.headers.get("cache-control")).toBe("no-store");
      return r.json();
    };
    expect((await get("가나다")).sellers).toEqual([{ id: a.seller.id, title: "가나다", sub: "slug-가나다", href: `/admin/partners/${a.seller.id}` }]);
    expect((await get("SLUG-라마")).sellers.map((s: { id: string }) => s.id)).toEqual([b.seller.id]);
    const ord = await get("7777", "CS");
    expect(ord.orders.map((o: { sub: string }) => o.sub).sort()).toEqual(["가나다", "라마바"]);
    expect((await get("TID-ABC-1")).payments).toEqual([{ id: pay.id, title: "TID-ABC-1", sub: "가나다", href: `/admin/partners/${a.seller.id}` }]);
    expect((await get("SUBPAY-1")).payments).toEqual([{ id: subPay.id, title: subPay.id, sub: "가나다", href: `/admin/billing/invoices/${subPay.id}` }]);
    expect((await get("tid-abc")).payments).toEqual([]); // 결제번호는 똑같이 맞아야 한다
    expect((await get("환불")).inquiries).toEqual([{ id: inq.id, title: "청구서 환불 문의", sub: "가나다", href: `/admin/support/inquiries/${inq.id}` }]);
    expect((await get(job.id)).jobs).toEqual([{ id: job.id, title: job.id, sub: "라마바", href: `/admin/ops/automation/${job.id}` }]);
    // 구매자 이름·연락처·닉네임은 마스터 검색에 없다
    for (const q of [a.buyer.name, a.buyer.phone, `단골가나다`]) {
      expect(await get(q)).toEqual({ sellers: [], orders: [], payments: [], inquiries: [], jobs: [] });
    }
    expect(await get("")).toEqual({ sellers: [], orders: [], payments: [], inquiries: [], jobs: [] });
  });

  it("종류별 최대 5건, 50자 넘으면 400, 비로그인·파트너스 로그인은 401", async () => {
    for (let i = 0; i < 7; i++) {
      const { seller } = await createSeller();
      await db.seller.update({ where: { id: seller.id }, data: { shopName: `공통상호 ${i}` } });
    }
    const r = await call(adminSearchRoute, "공통상호", await adminCookie());
    expect((await r.json()).sellers).toHaveLength(5);
    expect((await call(adminSearchRoute, "가".repeat(51), await adminCookie())).status).toBe(400);
    expect((await call(adminSearchRoute, "a", "")).status).toBe(401);
    const { seller } = await createSeller();
    const s = await sellerCookie(seller.id, "OWNER");
    expect((await call(adminSearchRoute, "a", s.cookie)).status).toBe(401);
  });
});

describe("파트너스 검색 GET /api/seller/search", () => {
  it("대표자는 내 쇼핑몰의 상품·주문번호·회원 닉네임·문의를 찾고, 다른 쇼핑몰 것은 나오지 않는다", async () => {
    const a = await shopData("가나다");
    const b = await shopData("라마바");
    const owner = await sellerCookie(a.seller.id, "OWNER");
    const ownerB = await sellerCookie(b.seller.id, "OWNER");
    await db.platformInquiry.create({ data: { sellerId: a.seller.id, createdBySellerUserId: owner.id, category: "BILLING", title: "청구서 문의" } });
    const get = async (q: string, cookie = owner.cookie) => {
      const r = await call(sellerSearchRoute, q, cookie);
      expect(r.status).toBe(200);
      return r.json();
    };
    expect((await get("포켓몬")).products).toEqual([{ id: a.product.id, title: "포켓몬카드 가나다", sub: "DRAFT", href: `/seller/products/${a.product.id}` }]);
    expect((await get("7777")).orders).toEqual([{ id: a.order.id, title: "7777", sub: "PENDING_PAYMENT", href: `/seller/orders/${a.order.id}` }]);
    expect((await get("단골")).members.map((m: { id: string }) => m.id)).toEqual([a.buyer.id]);
    expect((await get("청구서")).inquiries).toHaveLength(1);
    // 같은 주문번호·비슷한 이름이어도 상대 쇼핑몰 결과는 서로 보이지 않는다
    expect((await get("7777", ownerB.cookie)).orders.map((o: { id: string }) => o.id)).toEqual([b.order.id]);
    expect((await get("포켓몬", ownerB.cookie)).products.map((p: { id: string }) => p.id)).toEqual([b.product.id]);
    expect((await get("청구서", ownerB.cookie)).inquiries).toEqual([]);
    expect((await get("가나다", ownerB.cookie))).toEqual({ products: [], orders: [], members: [], inquiries: [] });
    // 구매자 이름·연락처로는 찾지 않는다
    expect((await get(a.buyer.name)).members).toEqual([]);
    expect((await get(a.buyer.phone.slice(-4))).members).toEqual([]);
  });

  it("직원은 권한 있는 종류만, 문의는 자기 것만. 비로그인 401·너무 긴 q 400", async () => {
    const a = await shopData("가나다");
    const owner = await sellerCookie(a.seller.id, "OWNER");
    const none = await sellerCookie(a.seller.id, { permissions: [] });
    const prod = await sellerCookie(a.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    await db.platformInquiry.create({ data: { sellerId: a.seller.id, createdBySellerUserId: owner.id, category: "BILLING", title: "대표 문의" } });
    await db.platformInquiry.create({ data: { sellerId: a.seller.id, createdBySellerUserId: none.id, category: "BILLING", title: "직원 문의" } });
    const get = async (q: string, cookie: string) => (await call(sellerSearchRoute, q, cookie)).json();
    expect(await get("포켓몬", none.cookie)).toMatchObject({ products: [] });
    expect((await get("포켓몬", prod.cookie)).products).toHaveLength(1);
    expect((await get("7777", prod.cookie)).orders).toEqual([]);
    expect((await get("단골", prod.cookie)).members).toEqual([]);
    expect((await get("문의", none.cookie)).inquiries.map((i: { title: string }) => i.title)).toEqual(["직원 문의"]);
    expect((await get("문의", owner.cookie)).inquiries).toHaveLength(2);
    expect((await call(sellerSearchRoute, "a", "")).status).toBe(401);
    expect((await call(sellerSearchRoute, "가".repeat(51), owner.cookie)).status).toBe(400);
  });
});
