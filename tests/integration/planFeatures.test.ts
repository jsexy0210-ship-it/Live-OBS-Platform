import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type React from "react";
import ShopSignupPage from "../../app/(shop)/shop/[slug]/signup/page";
import SignupForm from "../../components/shop/SignupForm";
import { GET as overlayState } from "../../app/api/overlay/[token]/state/route";
import { GET as overlayStream } from "../../app/api/overlay/[token]/stream/route";
import { GET as overlayVersion } from "../../app/api/overlay/[token]/version/route";
import { POST as linkConfirm } from "../../app/api/seller/me/identity/confirm/route";
import { POST as linkResend } from "../../app/api/seller/me/identity/resend/route";
import { POST as linkStart } from "../../app/api/seller/me/identity/start/route";
import { GET as sellerMe } from "../../app/api/seller/me/route";
import { GET as sellerOrders } from "../../app/api/seller/orders/route";
import { POST as overlayTokenRoute } from "../../app/api/seller/overlay/token/route";
import { GET as productsGet, POST as productsPost } from "../../app/api/seller/products/route";
import { GET as queueGet } from "../../app/api/seller/queue/route";
import { PUT as shippingPut } from "../../app/api/seller/shipping-policy/route";
import { GET as staffGet } from "../../app/api/seller/staff/route";
import { GET as subscriptionGet } from "../../app/api/seller/subscription/route";
import { GET as addressesGet, POST as addressesPost } from "../../app/api/shop/[slug]/addresses/route";
import { POST as buyerLogin } from "../../app/api/shop/[slug]/auth/login/route";
import { GET as consentGet, PUT as consentPut } from "../../app/api/shop/[slug]/me/marketing-consent/route";
import { GET as rejoinConsentGet } from "../../app/api/shop/[slug]/me/rejoin-retention-consent/route";
import { GET as rewardsGet } from "../../app/api/shop/[slug]/me/rewards/route";
import { POST as withdrawRoute } from "../../app/api/shop/[slug]/me/withdraw/route";
import { GET as ogRoute } from "../../app/api/shop/[slug]/og.png/route";
import { GET as orderConsentRoute } from "../../app/api/shop/[slug]/order-consent/route";
import { GET as buyerOrderDetail } from "../../app/api/shop/[slug]/orders/[orderId]/route";
import { GET as buyerOrders, POST as buyerOrderCreate } from "../../app/api/shop/[slug]/orders/route";
import { GET as shareRoute } from "../../app/api/shop/[slug]/share/route";
import { POST as signupRoute } from "../../app/api/shop/[slug]/signup/route";
import { POST as signupConfirm } from "../../app/api/shop/[slug]/signup/verification/confirm/route";
import { POST as signupResend } from "../../app/api/shop/[slug]/signup/verification/resend/route";
import { POST as signupStart } from "../../app/api/shop/[slug]/signup/verification/route";
import { loginSeller } from "../../lib/server/auth/login";
import { requireSeller } from "../../lib/server/authz/guards";
import { sellerFeatures } from "../../lib/server/billing/features";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { IDV_INPUT, PASSWORD, SIGNUP_CONSENT, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// ONQ 1-B 기능 권한(ARCHITECTURE 4.8.0). 막을 것은 거절되고 DB 변경 0건, 허용할 것은 지금처럼 동작하는지 경로마다 본다.
beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const DAY = 24 * 60 * 60 * 1000;
const ALL = ["OVERLAY", "EXTERNAL_INTEGRATION", "STORE_OPERATIONS"];
const BASE = "http://localhost:3000";
const H = { "content-type": "application/json", host: "localhost:3000", origin: BASE };
const req = (path: string, method = "GET", cookie?: string, body?: unknown) =>
  new Request(BASE + path, {
    method,
    headers: { ...H, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const slugCtx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const tokenCtx = (token: string) => ({ params: Promise.resolve({ token }) });
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

// 판매자에게 플랜을 붙인다. 플랜 행은 1-C 전이라 시험에서 만든다(가격은 정본 값).
async function setPlan(sellerId: string, code: "STANDARD" | "OVERLAY_ONLY" | "INTEGRATED", sub: { nextChargeAt?: Date } = {}) {
  const price = { STANDARD: [300_000, 199_000], OVERLAY_ONLY: [99_000, 69_000], INTEGRATED: [249_000, 179_000] }[code];
  const plan = await db.subscriptionPlan.upsert({ where: { code }, create: { code, name: code, listPrice: price[0], salePrice: price[1] }, update: {} });
  return db.sellerSubscription.upsert({
    where: { sellerId },
    create: { sellerId, planId: plan.id, status: "ACTIVE", nextChargeAt: sub.nextChargeAt ?? null },
    update: { planId: plan.id, nextChargeAt: sub.nextChargeAt ?? null },
  });
}

// 통합 첫 결제를 기다리는 판매자: 체험 없음, 카드 등록 뒤 결제 시각이 지났고 청구는 대기(PENDING). 잠금은 「charging」(열림)이다.
async function integratedAwaitingFirstPayment(sellerId: string) {
  await db.seller.update({ where: { id: sellerId }, data: { trialEndsAt: null } });
  const sub = await setPlan(sellerId, "INTEGRATED", { nextChargeAt: new Date(Date.now() - 60_000) });
  await db.subscriptionPayment.create({
    data: { sellerId, subscriptionId: sub.id, amount: 179_000, status: "PENDING", periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * DAY) },
  });
  return sub;
}

async function sellerCookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const cookie = await sellerCookie(owner.email);
  return { seller, grade, owner, cookie };
}

const errorOf = async (res: Response) => ((await res.json()) as { error?: string }).error;

describe("플랜 → 기능 권한", () => {
  it("구독 행 없는 기존 판매자와 STANDARD 구독은 지금처럼 모든 기능 권한(통합)", async () => {
    const a = await shop();
    expect(await sellerFeatures(db, a.seller.id)).toEqual(ALL);
    const b = await shop();
    await setPlan(b.seller.id, "STANDARD");
    expect(await sellerFeatures(db, b.seller.id)).toEqual(ALL);
  });

  it("오버레이 전용은 오버레이·외부 연동, 통합은 첫 결제 확정 뒤 모두, 모르는 플랜 코드는 없음", async () => {
    const o = await shop();
    await setPlan(o.seller.id, "OVERLAY_ONLY");
    expect(await sellerFeatures(db, o.seller.id)).toEqual(["OVERLAY", "EXTERNAL_INTEGRATION"]);

    const i = await shop();
    const sub = await integratedAwaitingFirstPayment(i.seller.id);
    expect(await sellerFeatures(db, i.seller.id)).toEqual([]);
    // 실패한 청구만 있어도 닫힘
    await db.subscriptionPayment.updateMany({ where: { sellerId: i.seller.id }, data: { status: "FAILED" } });
    expect(await sellerFeatures(db, i.seller.id)).toEqual([]);
    await db.subscriptionPayment.create({
      data: { sellerId: i.seller.id, subscriptionId: sub.id, amount: 179_000, status: "PAID", paidAt: new Date(), periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * DAY) },
    });
    expect(await sellerFeatures(db, i.seller.id)).toEqual(ALL);

    const u = await shop();
    const plan = await db.subscriptionPlan.create({ data: { code: "UNKNOWN_PLAN", name: "x", listPrice: 1, salePrice: 1 } });
    await db.sellerSubscription.create({ data: { sellerId: u.seller.id, planId: plan.id } });
    expect(await sellerFeatures(db, u.seller.id)).toEqual([]);
  });

  it("체험을 받은 적 있는 통합(1-C에서 옮긴 기존 판매자)은 첫 결제 전에도 연다. 체험이 끝나면 잠금 규칙(402)이 막고, 잠긴 동안 기존 주문 처리는 열린다", async () => {
    const s = await shop();
    await setPlan(s.seller.id, "INTEGRATED");
    expect(await sellerFeatures(db, s.seller.id)).toEqual(ALL);
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    expect(await sellerFeatures(db, s.seller.id)).toEqual(ALL);
    expect((await productsGet(req("/api/seller/products", "GET", s.cookie))).status).toBe(402);
    expect((await sellerOrders(req("/api/seller/orders", "GET", s.cookie))).status).toBe(200);
  });
});

describe("판매자 API: 오버레이 전용", () => {
  it("스토어 운영 API는 403 plan_feature_required이고 아무것도 바뀌지 않는다", async () => {
    const s = await shop();
    await setPlan(s.seller.id, "OVERLAY_ONLY");
    const create = await productsPost(req("/api/seller/products", "POST", s.cookie, { name: "부스터 팩", price: 5000 }));
    expect(create.status).toBe(403);
    expect(await errorOf(create)).toBe("plan_feature_required");
    expect(await db.product.count()).toBe(0);
    expect((await productsGet(req("/api/seller/products", "GET", s.cookie))).status).toBe(403);
    const before = await db.sellerShippingPolicy.count();
    expect((await shippingPut(req("/api/seller/shipping-policy", "PUT", s.cookie, { baseFee: 1 }))).status).toBe(403);
    expect(await db.sellerShippingPolicy.count()).toBe(before);
  });

  it("오버레이·방송, 기존 주문 처리, 직원 관리, 구독, 내 정보는 지금처럼 열린다", async () => {
    const s = await shop();
    await setPlan(s.seller.id, "OVERLAY_ONLY");
    expect((await overlayTokenRoute(req("/api/seller/overlay/token", "POST", s.cookie, {}))).status).toBe(200);
    expect((await queueGet(req("/api/seller/queue", "GET", s.cookie))).status).toBe(200);
    expect((await sellerOrders(req("/api/seller/orders", "GET", s.cookie))).status).toBe(200);
    expect((await staffGet(req("/api/seller/staff", "GET", s.cookie))).status).toBe(200);
    expect((await subscriptionGet(req("/api/seller/subscription", "GET", s.cookie))).status).toBe(200);
    const me = await sellerMe(req("/api/seller/me", "GET", s.cookie));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ features: ["OVERLAY", "EXTERNAL_INTEGRATION"] });
  });

  it("직원은 기능 권한과 직원 권한의 교집합: 상품 관리 권한이 있어도 스토어 운영이 없으면 403, 오버레이는 열림", async () => {
    const s = await shop();
    await setPlan(s.seller.id, "OVERLAY_ONLY");
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE", "OVERLAY_EDIT"] });
    const cookie = await sellerCookie(staff.email);
    expect((await productsPost(req("/api/seller/products", "POST", cookie, { name: "x", price: 1000 }))).status).toBe(403);
    expect(await db.product.count()).toBe(0);
    expect((await overlayTokenRoute(req("/api/seller/overlay/token", "POST", cookie, {}))).status).toBe(200);
    // 플랜이 주는 권한이어도 직원 권한이 없으면 지금처럼 403
    const noOverlay = await sellerCookie((await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] })).email);
    expect((await overlayTokenRoute(req("/api/seller/overlay/token", "POST", noOverlay, {}))).status).toBe(403);
  });
});

describe("판매자 API: 통합 첫 결제 확정 전", () => {
  it("구독·결제와 내 정보만 열리고, 나머지는 403(기존 주문 처리·직원 관리 포함)", async () => {
    const s = await shop();
    await integratedAwaitingFirstPayment(s.seller.id);
    expect((await subscriptionGet(req("/api/seller/subscription", "GET", s.cookie))).status).toBe(200);
    const me = await sellerMe(req("/api/seller/me", "GET", s.cookie));
    expect(await me.json()).toMatchObject({ access: "charging", features: [] });
    for (const res of [
      await productsPost(req("/api/seller/products", "POST", s.cookie, { name: "x", price: 1000 })),
      await overlayTokenRoute(req("/api/seller/overlay/token", "POST", s.cookie, {})),
      await queueGet(req("/api/seller/queue", "GET", s.cookie)),
      await sellerOrders(req("/api/seller/orders", "GET", s.cookie)),
      await staffGet(req("/api/seller/staff", "GET", s.cookie)),
    ]) {
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("plan_feature_required");
    }
    expect(await db.product.count()).toBe(0);
    expect(await db.overlayToken.count()).toBe(0);
  });

  it("첫 결제가 확정(PAID)되면 열린다", async () => {
    const s = await shop();
    const sub = await integratedAwaitingFirstPayment(s.seller.id);
    await db.subscriptionPayment.updateMany({ where: { subscriptionId: sub.id }, data: { status: "PAID", paidAt: new Date() } });
    expect((await productsPost(req("/api/seller/products", "POST", s.cookie, { name: "x", price: 1000 }))).status).toBe(201);
    expect((await sellerOrders(req("/api/seller/orders", "GET", s.cookie))).status).toBe(200);
  });

  it("직원 본인확인 연결을 시작한 뒤 통합 결제 대기로 바뀌면 다시 받기·확인도 403이고 기록은 그대로다(#176 Codex P2)", async () => {
    const s = await shop();
    const staff = await createSellerUser(s.seller.id, "MANAGER");
    await db.sellerUser.update({ where: { id: staff.id }, data: { phone: "01055556666" } });
    const cookie = await sellerCookie(staff.email);
    const start = await linkStart(req("/api/seller/me/identity/start", "POST", cookie, { ...IDV_INPUT, name: "직원", phone: "010-5555-6666" }));
    expect(start.status).toBe(200);
    const flow = (start.headers.getSetCookie().find((c) => c.startsWith("lo_lidv=")) ?? "").split(";")[0];
    const { verificationId } = (await start.json()) as { verificationId: string };
    await integratedAwaitingFirstPayment(s.seller.id);
    const before = await db.identityVerification.findUniqueOrThrow({ where: { id: verificationId } });
    for (const res of [
      await linkResend(req("/api/seller/me/identity/resend", "POST", flow, { verificationId })),
      await linkConfirm(req("/api/seller/me/identity/confirm", "POST", flow, { verificationId, code: "000000" })),
    ]) {
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toBe("plan_feature_required");
    }
    expect(await db.identityVerification.findUniqueOrThrow({ where: { id: verificationId } })).toEqual(before);
  });

  it("잠금이 먼저다: 잠긴 판매자는 기능 권한과 관계없이 402", async () => {
    const s = await shop();
    await setPlan(s.seller.id, "OVERLAY_ONLY");
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    const res = await productsGet(req("/api/seller/products", "GET", s.cookie));
    expect(res.status).toBe(402);
    expect(await errorOf(res)).toBe("subscription_required");
  });

  it("feature 없이 부르는 가드(라이브러리·기존 시험)는 지금처럼 잠금만 본다", async () => {
    const s = await shop();
    await integratedAwaitingFirstPayment(s.seller.id);
    await expect(requireSeller(db, s.cookie.replace("lo_seller=", ""))).resolves.toMatchObject({ sellerId: s.seller.id });
  });
});

describe("공개·구매자 경로: 스토어 운영 권한이 없는 쇼핑몰(ARCHITECTURE 4.8.0 표)", () => {
  // 오버레이 전용으로 내려가기 전에 받은 주문과 가입한 구매자가 있는 쇼핑몰
  async function downgradedShop() {
    const s = await shop();
    const product = await db.product.create({ data: { sellerId: s.seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: s.seller.id, productId: product.id, name: "1박스", stock: 50 } });
    const buyer = await createLoginBuyer(s.seller.id, s.grade.id);
    const other = await createLoginBuyer(s.seller.id, s.grade.id);
    const made = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity: 1 }], consent, shippingAddress: addr });
    if (!made.ok) throw new Error(made.reason);
    // 가입 본인확인을 내려가기 전에 시작해 둔다(다시 받기·확인·가입이 막히는지 보려고)
    const start = await signupStart(req(`/api/shop/${s.seller.slug}/signup/verification`, "POST", undefined, { ...IDV_INPUT, ...SIGNUP_CONSENT }), slugCtx(s.seller.slug));
    expect(start.status).toBe(200);
    const idvCookie = (start.headers.getSetCookie().find((c) => c.startsWith("lo_bidv=")) ?? "").split(";")[0];
    const { verificationId } = (await start.json()) as { verificationId: string };
    await setPlan(s.seller.id, "OVERLAY_ONLY");
    const login = async (loginId: string) => {
      const res = await buyerLogin(req(`/api/shop/${s.seller.slug}/auth/login`, "POST", undefined, { loginId, password: PASSWORD }), slugCtx(s.seller.slug));
      expect(res.status).toBe(200);
      return (res.headers.get("set-cookie") ?? "").split(";")[0];
    };
    return { ...s, option, buyer, other, orderId: made.orderId, idvCookie, verificationId, login };
  }

  it("새 거래 시작(주문 생성·주문서 동의 문구·구매자 가입·공유 미리보기)은 막고 DB 변경 0건", async () => {
    const s = await downgradedShop();
    const slug = s.seller.slug;
    const counts = async () => ({
      orders: await db.order.count(),
      buyers: await db.buyerMember.count(),
      idv: await db.identityVerification.count(),
      idvSends: (await db.identityVerification.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: { sendCount: true, otpFailCount: true, useAttemptCount: true, status: true } })).map((v) => JSON.stringify(v)).join(),
      audits: await db.auditLog.count(),
    });
    const before = await counts();
    const buyerCookie = await s.login(s.buyer.loginId);
    const afterLogin = await counts();

    const order = await buyerOrderCreate(req(`/api/shop/${slug}/orders`, "POST", buyerCookie, { items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress: addr }), slugCtx(slug));
    expect(order.status).toBe(402);
    expect(await errorOf(order)).toBe("shop_unavailable");
    const oc = await orderConsentRoute(req(`/api/shop/${slug}/order-consent`), slugCtx(slug));
    expect(oc.status).toBe(402);
    expect(await errorOf(oc)).toBe("shop_unavailable");

    const start = await signupStart(req(`/api/shop/${slug}/signup/verification`, "POST", undefined, { ...IDV_INPUT, ...SIGNUP_CONSENT }), slugCtx(slug));
    expect(start.status).toBe(402);
    const resend = await signupResend(req(`/api/shop/${slug}/signup/verification/resend`, "POST", s.idvCookie, { verificationId: s.verificationId }), slugCtx(slug));
    expect(resend.status).toBe(402);
    const confirm = await signupConfirm(req(`/api/shop/${slug}/signup/verification/confirm`, "POST", s.idvCookie, { verificationId: s.verificationId, code: "000000" }), slugCtx(slug));
    expect(confirm.status).toBe(402);
    const signup = await signupRoute(
      req(`/api/shop/${slug}/signup`, "POST", s.idvCookie, { verificationId: s.verificationId, loginId: "new@example.com", password: "pw-123456", broadcastNickname: "새회원", agreedTerms: true, agreedPrivacy: true }),
      slugCtx(slug),
    );
    expect(signup.status).toBe(402);

    expect((await shareRoute(req(`/api/shop/${slug}/share`), slugCtx(slug))).status).toBe(404);
    expect((await ogRoute(req(`/api/shop/${slug}/og.png`), slugCtx(slug))).status).toBe(404);

    // 구매자 로그인 세션 행만 늘고(허용), 막힌 요청은 아무것도 남기지 않는다
    expect(await counts()).toEqual(afterLogin);
    expect(afterLogin.orders).toBe(before.orders);
  });

  it("기존 주문 조회·구매자 로그인·배송지·동의 철회·탈퇴는 지금처럼 열린다", async () => {
    const s = await downgradedShop();
    const slug = s.seller.slug;
    const cookie = await s.login(s.buyer.loginId);
    const list = await buyerOrders(req(`/api/shop/${slug}/orders`, "GET", cookie), slugCtx(slug));
    expect(list.status).toBe(200);
    expect(((await list.json()) as { orders: unknown[] }).orders).toHaveLength(1);
    expect((await buyerOrderDetail(req(`/api/shop/${slug}/orders/${s.orderId}`, "GET", cookie), { params: Promise.resolve({ slug, orderId: s.orderId }) })).status).toBe(200);
    expect((await addressesGet(req(`/api/shop/${slug}/addresses`, "GET", cookie), slugCtx(slug))).status).toBe(200);
    // 주문 때 저장된 배송지와 다른 주소를 더한다(같은 주소는 409 중복)
    expect((await addressesPost(req(`/api/shop/${slug}/addresses`, "POST", cookie, { ...addr, address1: "부산 해운대구 1" }), slugCtx(slug))).status).toBe(201);
    expect((await consentGet(req(`/api/shop/${slug}/me/marketing-consent`, "GET", cookie), slugCtx(slug))).status).toBe(200);
    expect((await consentPut(req(`/api/shop/${slug}/me/marketing-consent`, "PUT", cookie, { agreed: false }), slugCtx(slug))).status).toBe(200);
    expect((await rewardsGet(req(`/api/shop/${slug}/me/rewards`, "GET", cookie), slugCtx(slug))).status).toBe(200);
    expect((await rejoinConsentGet(req(`/api/shop/${slug}/me/rejoin-retention-consent`, "GET", cookie), slugCtx(slug))).status).toBe(200);
    // 진행 중 주문이 없는 다른 구매자는 탈퇴할 수 있다
    const otherCookie = await s.login(s.other.loginId);
    expect((await withdrawRoute(req(`/api/shop/${slug}/me/withdraw`, "POST", otherCookie, { password: PASSWORD }), slugCtx(slug))).status).toBe(200);
  });
});

describe("서버 렌더 쇼핑몰 화면(ARCHITECTURE 4.8.0 ③)", () => {
  type El = { type: unknown; props: { children?: unknown } };
  const page = async (slug: string) => (await ShopSignupPage({ params: Promise.resolve({ slug }) })) as unknown as El;

  it("구매자 가입 화면: 스토어 운영 권한이 없으면 안내 화면이고 가입 폼이 없다. 있으면 지금처럼 가입 폼을 그린다", async () => {
    const s = await shop();
    // 가입 폼(SignupForm)은 앱 라우터가 있어야 그려져서, 열린 경우는 화면이 고른 컴포넌트로 본다
    expect(((await page(s.seller.slug)).props.children as El).type).toBe(SignupForm);
    await setPlan(s.seller.id, "OVERLAY_ONLY");
    const closedEl = await page(s.seller.slug);
    expect((closedEl.props.children as El).type).not.toBe(SignupForm);
    const closed = renderToStaticMarkup(closedEl as unknown as React.ReactElement);
    expect(closed).toContain("지금은 쇼핑몰을 이용할 수 없어요");
    expect(closed).not.toContain("<form");
    expect(closed).not.toContain("<input");
  });
});

describe("오버레이 공개 주소", () => {
  async function overlayToken(cookie: string) {
    const res = await overlayTokenRoute(req("/api/seller/overlay/token", "POST", cookie, {}));
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  it("오버레이 전용은 열리고, 통합 첫 결제 확정 전에는 state·version·stream 모두 404", async () => {
    const o = await shop();
    await setPlan(o.seller.id, "OVERLAY_ONLY");
    const ot = await overlayToken(o.cookie);
    expect((await overlayState(req(`/api/overlay/${ot}/state`), tokenCtx(ot))).status).toBe(200);
    expect((await overlayVersion(req(`/api/overlay/${ot}/version`), tokenCtx(ot))).status).toBe(200);

    const i = await shop();
    const itok = await overlayToken(i.cookie); // 토큰은 체험 중(STANDARD)에 받아 두었다
    await integratedAwaitingFirstPayment(i.seller.id);
    expect((await overlayState(req(`/api/overlay/${itok}/state`), tokenCtx(itok))).status).toBe(404);
    expect((await overlayVersion(req(`/api/overlay/${itok}/version`), tokenCtx(itok))).status).toBe(404);
    expect((await overlayStream(req(`/api/overlay/${itok}/stream`), tokenCtx(itok))).status).toBe(404);
  });
});
