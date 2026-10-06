import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as getRoute, POST as postRoute } from "../../app/api/seller/onboarding/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 시작하기(SA-003)·온보딩(SA-004): 플랜별 단계(통합·오버레이 전용), 기존 데이터에서 계산되는 완료, 이어 하기(currentStep), 주소 복사·닫기 저장, 권한·격리.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const req = (cookie: string, method = "GET", body?: unknown) =>
  new Request(`${BASE}/api/seller/onboarding`, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function login(sellerId: string, kind: Parameters<typeof createSellerUser>[1]) {
  const u = await createSellerUser(sellerId, kind);
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop(planCode: "INTEGRATED" | "OVERLAY_ONLY") {
  const plans = await seedPlans();
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { planId: plans[planCode].id } });
  return seller;
}
const get = async (cookie: string) => (await getRoute(req(cookie))).json();
const keys = (b: { steps: { key: string }[] }) => b.steps.map((s) => s.key);
const doneKeys = (b: { steps: { key: string; done: boolean }[] }) => b.steps.filter((s) => s.done).map((s) => s.key);

describe("시작하기 체크리스트 GET /api/seller/onboarding", () => {
  it("비로그인 401. 쇼핑몰 통합은 6단계, 처음에는 모두 미완료이고 구독이 첫 단계", async () => {
    const seller = await shop("INTEGRATED");
    expect((await getRoute(req(""))).status).toBe(401);
    const b = await get(await login(seller.id, "OWNER"));
    expect(b).toMatchObject({ track: "INTEGRATED", planCode: "INTEGRATED", total: 6, doneCount: 0, currentStep: "subscription", completed: false, dismissed: false, trialEndsAt: null });
    expect(keys(b)).toEqual(["subscription", "shop_info", "products", "order_policy", "overlay", "overlay_url"]);
    expect(b.steps[0]).toEqual({ key: "subscription", done: false, status: "CURRENT", href: "/seller/subscription" });
    expect(b.steps.slice(1).every((s: { status: string }) => s.status === "WAITING")).toBe(true);
  });

  it("기존 데이터에서 완료가 계산되고, 순서와 상관없이 첫 미완료 단계로 이어진다. 끝까지 하면 completed", async () => {
    const seller = await shop("INTEGRATED");
    const owner = await login(seller.id, "OWNER");
    const plans = await db.subscriptionPlan.findFirstOrThrow({ where: { code: "INTEGRATED" } });
    const sub = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plans.id } });
    // 상품만 먼저 등록: 구독 단계가 첫 미완료로 남는다
    await db.product.create({ data: { sellerId: seller.id, name: "카드", price: 1000 } });
    let b = await get(owner);
    expect(doneKeys(b)).toEqual(["products"]);
    expect(b.currentStep).toBe("subscription");
    // 지운 상품은 세지 않는다
    await db.product.updateMany({ where: { sellerId: seller.id }, data: { deletedAt: new Date() } });
    expect(doneKeys(await get(owner))).toEqual([]);
    await db.product.create({ data: { sellerId: seller.id, name: "카드2", price: 1000 } });
    await db.subscriptionPayment.create({ data: { sellerId: seller.id, subscriptionId: sub.id, amount: 1000, status: "PAID", periodStart: new Date(), periodEnd: new Date(Date.now() + 86_400_000) } });
    await db.seller.update({ where: { id: seller.id }, data: { shareTitle: "우리 가게" } });
    await db.sellerOrderPolicy.create({ data: { sellerId: seller.id } });
    b = await get(owner);
    expect(doneKeys(b)).toEqual(["subscription", "shop_info", "products", "order_policy"]);
    expect(b).toMatchObject({ currentStep: "overlay", doneCount: 4, completed: false });
    await db.overlayLayout.create({ data: { sellerId: seller.id, aspect: "16x9", templateKey: "basic", widgets: [] } });
    expect((await get(owner)).currentStep).toBe("overlay_url");
    expect((await postRoute(req(owner, "POST", { action: "overlay_url_copied" }))).status).toBe(200);
    b = await get(owner);
    expect(b).toMatchObject({ currentStep: null, doneCount: 6, completed: true });
  });

  it("오버레이 전용은 3단계(외부 쇼핑몰 연동 → 오버레이 → 주소 복사)와 체험 종료일. 연결 중인 쇼핑몰만 완료로 센다", async () => {
    const seller = await shop("OVERLAY_ONLY");
    const trialEndsAt = new Date(Date.now() + 5 * 86_400_000);
    await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt } });
    const owner = await login(seller.id, "OWNER");
    let b = await get(owner);
    expect(keys(b)).toEqual(["external_shop", "overlay", "overlay_url"]);
    expect(b).toMatchObject({ track: "OVERLAY_ONLY", total: 3, currentStep: "external_shop", trialEndsAt: trialEndsAt.toISOString() });
    expect(b.steps[0].href).toBe("/seller/external-shops");
    await db.externalShopConnection.create({ data: { sellerId: seller.id, shopKey: "shop-a", status: "DISCONNECTED" } });
    expect(doneKeys(await get(owner))).toEqual([]);
    await db.externalShopConnection.create({ data: { sellerId: seller.id, shopKey: "shop-b", status: "CONNECTED" } });
    b = await get(owner);
    expect(doneKeys(b)).toEqual(["external_shop"]);
    expect(b.currentStep).toBe("overlay");
  });

  it("다른 쇼핑몰의 상품·연동은 세지 않는다", async () => {
    const a = await shop("INTEGRATED");
    const { seller: other } = await createSeller();
    await db.product.create({ data: { sellerId: other.id, name: "남의 상품", price: 1000 } });
    await db.sellerOrderPolicy.create({ data: { sellerId: other.id } });
    expect(doneKeys(await get(await login(a.id, "OWNER")))).toEqual([]);
  });

  it("알 수 없는 플랜은 빈 목록(null 갈래)", async () => {
    const { seller } = await createSeller();
    await seedPlans();
    await db.subscriptionPlan.create({ data: { code: "WEIRD", name: "이상한", listPrice: 1, salePrice: 1 } });
    const w = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "WEIRD" } });
    await db.seller.update({ where: { id: seller.id }, data: { planId: w.id } });
    expect(await get(await login(seller.id, "OWNER"))).toMatchObject({ track: null, steps: [], total: 0, currentStep: null, completed: false });
  });
});

describe("저장 POST /api/seller/onboarding", () => {
  it("주소 복사·닫기·다시 열기를 저장한다. 잘못된 action 400. 직원은 쇼핑몰 설정 권한이 있어야 하고 없으면 403(조회는 가능)", async () => {
    const seller = await shop("OVERLAY_ONLY");
    const owner = await login(seller.id, "OWNER");
    const none = await login(seller.id, { permissions: [] });
    const shopper = await login(seller.id, { permissions: ["SHOP_SETTINGS"] });
    expect((await postRoute(req(owner, "POST", { action: "bad" }))).status).toBe(400);
    expect((await postRoute(req(owner, "POST", {}))).status).toBe(400);
    expect((await postRoute(req(none, "POST", { action: "dismiss" }))).status).toBe(403);
    expect((await getRoute(req(none))).status).toBe(200);
    expect((await postRoute(req(shopper, "POST", { action: "dismiss" }))).status).toBe(200);
    expect((await get(owner)).dismissed).toBe(true);
    expect((await postRoute(req(owner, "POST", { action: "reopen" }))).status).toBe(200);
    expect((await get(owner)).dismissed).toBe(false);
    expect((await postRoute(req(owner, "POST", { action: "overlay_url_copied" }))).status).toBe(200);
    expect(doneKeys(await get(owner))).toEqual(["overlay_url"]);
    expect(await db.sellerOnboarding.count()).toBe(1);
  });

  it("다른 쇼핑몰의 상태에 영향을 주지 않고, Origin 없는 요청은 403", async () => {
    const a = await shop("OVERLAY_ONLY");
    const { seller: b } = await createSeller();
    const ownerA = await login(a.id, "OWNER");
    const ownerB = await login(b.id, "OWNER");
    await postRoute(req(ownerA, "POST", { action: "overlay_url_copied" }));
    expect(doneKeys(await get(ownerB))).toEqual([]);
    const noOrigin = new Request(`${BASE}/api/seller/onboarding`, { method: "POST", headers: { host: "localhost:3000", cookie: ownerA, "content-type": "application/json" }, body: JSON.stringify({ action: "dismiss" }) });
    expect((await postRoute(noOrigin)).status).toBe(403);
  });
});

describe("시작하기 SA-003 확장: 상태 3종·지금 상태·갈래 바꾸기", () => {
  it("단계 상태(DONE·CURRENT·WAITING)와 「지금 상태」 요약, 대표자 여부, 갈래 바꾸기 가능 여부", async () => {
    const seller = await shop("INTEGRATED");
    await db.product.create({ data: { sellerId: seller.id, name: "부스터", price: 1000, status: "ON_SALE" } });
    await db.seller.update({ where: { id: seller.id }, data: { shopTagline: "매일 밤 8시 라이브" } });
    const owner = await login(seller.id, "OWNER");
    const b = await get(owner);
    expect(b.steps.map((s: { key: string; status: string }) => `${s.key}:${s.status}`)).toEqual([
      "subscription:CURRENT",
      "shop_info:DONE",
      "products:DONE",
      "order_policy:WAITING",
      "overlay:WAITING",
      "overlay_url:WAITING",
    ]);
    expect(b.steps.find((s: { key: string }) => s.key === "shop_info").href).toBe("/seller/settings/shop");
    expect(b).toMatchObject({ isOwner: true, trackChangeable: true, summary: { plan: { code: "INTEGRATED", paid: false }, shopSlug: seller.slug, billingConnected: false, productCount: 1, overlayUrlCopied: false } });
    expect((await get(await login(seller.id, "MANAGER"))).isOwner).toBe(false);
    await postRoute(req(owner, "POST", { action: "overlay_url_copied" }));
    expect((await get(owner)).summary.overlayUrlCopied).toBe(true);
  });

  it("갈래 바꾸기: 구독 전에는 바뀌고 체험 종료일이 승인일 기준으로 다시 정해진다. 구독이 있으면 409. 잘못된 값 400. 권한 없으면 403. 로그 추적", async () => {
    const plans = await seedPlans();
    const { seller } = await createSeller();
    const approvedAt = new Date(Date.now() - 2 * 86_400_000);
    await db.seller.update({ where: { id: seller.id }, data: { planId: plans.INTEGRATED.id, approvedAt, trialEndsAt: null } });
    const owner = await login(seller.id, "OWNER");
    const post = (body: unknown, cookie = owner) => postRoute(req(cookie, "POST", body));
    const r = await post({ action: "change_track", track: "OVERLAY_ONLY" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, track: "OVERLAY_ONLY", changed: true });
    const after = await db.seller.findUniqueOrThrow({ where: { id: seller.id } });
    expect(after.planId).toBe(plans.OVERLAY_ONLY.id);
    expect(after.trialEndsAt!.getTime()).toBe(approvedAt.getTime() + 7 * 86_400_000);
    expect(await get(owner)).toMatchObject({ track: "OVERLAY_ONLY", total: 3 });
    expect(await (await post({ action: "change_track", track: "OVERLAY_ONLY" })).json()).toEqual({ ok: true, track: "OVERLAY_ONLY", changed: false });
    expect(await db.auditLog.count({ where: { action: "onboarding.track_change", sellerId: seller.id } })).toBe(1);
    // 다시 쇼핑몰까지 쓰기로: 체험 없음
    expect((await post({ action: "change_track", track: "INTEGRATED" })).status).toBe(200);
    expect((await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).trialEndsAt).toBeNull();
    for (const track of ["X", undefined, null, "STANDARD"]) {
      const bad = await post({ action: "change_track", track });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toBe("invalid_track");
    }
    expect((await post({ action: "change_track", track: "OVERLAY_ONLY" }, await login(seller.id, "MANAGER"))).status).toBe(403);
    // 구독을 만든 뒤에는 잠긴다
    await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plans.INTEGRATED.id, status: "ACTIVE" } });
    const locked = await post({ action: "change_track", track: "OVERLAY_ONLY" });
    expect(locked.status).toBe(409);
    expect((await locked.json()).error).toBe("track_locked");
    expect((await get(owner)).trackChangeable).toBe(false);
  });
});

