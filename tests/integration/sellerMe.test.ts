import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as sellerLogin } from "../../app/api/seller/auth/login/route";
import { GET as meRoute } from "../../app/api/seller/me/route";
import { prisma } from "../../lib/server/db";
import { LOGIN_ERROR_MESSAGES } from "../../lib/server/auth/messages";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const login = (body: unknown) => sellerLogin(new Request("http://localhost:3000/api/seller/auth/login", { method: "POST", headers: H, body: JSON.stringify(body) }));
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];
const me = (cookie?: string) => meRoute(new Request("http://localhost:3000/api/seller/me", { headers: { ...H, ...(cookie ? { cookie } : {}) } }));

describe("판매자 로그인 실패 응답", () => {
  it("{ error, message } 합니다체 문구로 주고, 이메일이 없을 때와 비밀번호가 틀릴 때 같은 응답이다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const wrongPassword = await login({ email: owner.email, password: "wrong-password-1" });
    const unknownEmail = await login({ email: "nobody@example.com", password: PASSWORD });
    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_credentials", message: "이메일이나 비밀번호가 맞지 않습니다" });
    }
    const empty = await login({ email: owner.email });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "bad_request", message: LOGIN_ERROR_MESSAGES.bad_request });
  });

  it("승인 대기·비활성 직원·여러 쇼핑몰은 사유별 코드와 문구, 이용 정지는 로그인된다(신규만 막기)", async () => {
    const pending = await createSeller();
    await db.seller.update({ where: { id: pending.seller.id }, data: { status: "PENDING" } });
    const p = await createSellerUser(pending.seller.id, "OWNER");
    const suspended = await createSeller();
    await db.seller.update({ where: { id: suspended.seller.id }, data: { status: "SUSPENDED" } });
    const su = await createSellerUser(suspended.seller.id, "OWNER");
    const active = await createSeller();
    const staff = await createSellerUser(active.seller.id, "BROADCASTER");
    await db.sellerUser.update({ where: { id: staff.id }, data: { status: "DISABLED" } });
    const shared = "shared@example.com";
    const s1 = await createSeller();
    const s2 = await createSeller();
    await createSellerUser(s1.seller.id, "OWNER", shared);
    await createSellerUser(s2.seller.id, "OWNER", shared);
    for (const [email, status, code] of [
      [p.email, 403, "seller_pending"],
      [staff.email, 403, "account_disabled"],
      [shared, 409, "shop_required"],
    ] as const) {
      const res = await login({ email, password: PASSWORD });
      expect(res.status, code).toBe(status);
      expect(await res.json()).toEqual({ error: code, message: LOGIN_ERROR_MESSAGES[code] });
    }
    expect((await login({ email: shared, password: PASSWORD, shopSlug: s2.seller.slug })).status).toBe(200);
    expect((await login({ email: su.email, password: PASSWORD })).status).toBe(200);
  });
});

describe("GET /api/seller/me", () => {
  it("쇼핑몰 이름·slug, 직원 이름·이메일을 주고 no-store. 같은 이메일의 다른 쇼핑몰 정보가 섞이지 않는다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const shared = "same@example.com";
    const ua = await createSellerUser(a.seller.id, "OWNER", shared);
    const ub = await createSellerUser(b.seller.id, { permissions: ["PRODUCT_MANAGE"] }, shared);
    await db.sellerUser.update({ where: { id: ub.id }, data: { name: "직원 B" } });
    const ca = cookieOf(await login({ email: shared, password: PASSWORD, shopSlug: a.seller.slug }));
    const cb = cookieOf(await login({ email: shared, password: PASSWORD, shopSlug: b.seller.slug }));
    const ra = await me(ca);
    expect(ra.status).toBe(200);
    expect(ra.headers.get("cache-control")).toBe("no-store");
    expect(await ra.json()).toMatchObject({
      sellerId: a.seller.id,
      userId: ua.id,
      isOwner: true,
      shop: { name: a.seller.shopName, slug: a.seller.slug },
      user: { name: "직원", email: shared },
    });
    const bodyB = await (await me(cb)).json();
    expect(bodyB).toMatchObject({ sellerId: b.seller.id, userId: ub.id, isOwner: false, permissions: ["PRODUCT_MANAGE"], shop: { slug: b.seller.slug }, user: { name: "직원 B" } });
    expect(JSON.stringify(bodyB)).not.toContain(a.seller.slug);
    expect(JSON.stringify(bodyB)).not.toContain(a.seller.id);
  });

  it("잠긴 판매자(체험 끝)도 200으로 열리고 이용 상태를 알려 준다. 로그인 안 함은 401(no-store)", async () => {
    const s = await createSeller();
    const owner = await createSellerUser(s.seller.id, "OWNER");
    const c = cookieOf(await login({ email: owner.email, password: PASSWORD }));
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    const res = await me(c);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ access: "expired", trialEndsAt: null });
    const anon = await me();
    expect(anon.status).toBe(401);
    expect(anon.headers.get("cache-control")).toBe("no-store");
  });

  it("체험 중이면 직원 세션에도 trialEndsAt(날짜만)을 주고, 다른 쇼핑몰 값은 섞이지 않는다. 체험이 아니면 null", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const endsA = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const endsB = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000);
    await db.seller.update({ where: { id: a.seller.id }, data: { trialEndsAt: endsA } });
    await db.seller.update({ where: { id: b.seller.id }, data: { trialEndsAt: endsB } });
    const shared = "trial@example.com";
    await createSellerUser(a.seller.id, { permissions: ["PRODUCT_MANAGE"] }, shared);
    await createSellerUser(b.seller.id, "OWNER", shared);
    const ca = cookieOf(await login({ email: shared, password: PASSWORD, shopSlug: a.seller.slug }));
    const cb = cookieOf(await login({ email: shared, password: PASSWORD, shopSlug: b.seller.slug }));
    const bodyA = await (await me(ca)).json();
    expect(bodyA).toMatchObject({ isOwner: false, access: "trial", trialEndsAt: endsA.toISOString() });
    expect(JSON.stringify(bodyA)).not.toContain(endsB.toISOString());
    // 금액·결제 정보는 주지 않는다
    expect(Object.keys(bodyA).sort()).toEqual(["access", "features", "impersonation", "isOwner", "orderFollowup", "permissions", "readOnly", "sellerId", "shop", "suspended", "trialEndsAt", "user", "userId"]);
    expect(bodyA).toMatchObject({ readOnly: false, impersonation: null });
    expect(await (await me(cb)).json()).toMatchObject({ isOwner: true, trialEndsAt: endsB.toISOString() });
    // 결제한 기간이 남아 체험이 아닌 상태면 null
    const plan = await db.subscriptionPlan.upsert({ where: { code: "STANDARD" }, update: {}, create: { code: "STANDARD", name: "스탠다드", listPrice: 30000, salePrice: 30000 } });
    await db.sellerSubscription.create({ data: { sellerId: a.seller.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
    expect(await (await me(ca)).json()).toMatchObject({ access: "paid", trialEndsAt: null });
  });
});
