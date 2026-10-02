import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PASSWORD, adminCredentials, createAdmin, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";
import { POST as adminLogin } from "../../app/api/admin/auth/login/route";
import { POST as adminLogout } from "../../app/api/admin/auth/logout/route";
import { GET as adminMe } from "../../app/api/admin/me/route";
import { POST as sellerLogin } from "../../app/api/seller/auth/login/route";
import { GET as sellerOrder } from "../../app/api/seller/orders/[orderId]/route";
import { POST as buyerLogin } from "../../app/api/shop/[slug]/auth/login/route";
import { prisma } from "../../lib/server/db";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3000", origin: BASE, ...headers },
    body: JSON.stringify(body),
  });
const get = (path: string, cookie?: string) =>
  new Request(BASE + path, { headers: cookie ? { cookie, host: "localhost:3000" } : { host: "localhost:3000" } });

// Set-Cookie에서 "이름=값"만 꺼낸다.
const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

describe("HTTP: 로그인·세션 쿠키", () => {
  it("마스터 로그인 → HttpOnly 쿠키 → 내 정보 → 로그아웃 후 401", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const res = await adminLogin(post("/api/admin/auth/login", adminCredentials(admin)));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^lo_admin=/);
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie.toLowerCase()).toContain("samesite=lax");
    const cookie = cookieOf(res);

    const me = await adminMe(get("/api/admin/me", cookie));
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ id: admin.id, role: "SUPER_ADMIN" });

    expect((await adminLogout(post("/api/admin/auth/logout", {}, { cookie }))).status).toBe(200);
    expect((await adminMe(get("/api/admin/me", cookie))).status).toBe(401);
  });

  it("틀린 비밀번호는 매번 401이고 잠기지 않는다 (6번째 맞으면 200)", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await adminLogin(post("/api/admin/auth/login", { ...adminCredentials(admin), password: "x" }))).status);
    }
    statuses.push((await adminLogin(post("/api/admin/auth/login", adminCredentials(admin)))).status);
    expect(statuses).toEqual([401, 401, 401, 401, 401, 200]);
  });

  it("다른 사이트에서 온 로그인 요청(Origin 불일치)과 Origin이 없는 변경 요청은 403", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const creds = adminCredentials(admin);
    expect((await adminLogin(post("/api/admin/auth/login", creds, { origin: "https://evil.example" }))).status).toBe(403);
    const noOrigin = new Request(BASE + "/api/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000" },
      body: JSON.stringify(creds),
    });
    expect((await adminLogin(noOrigin)).status).toBe(403);
    expect((await adminLogout(new Request(BASE + "/api/admin/auth/logout", { method: "POST", headers: { host: "localhost:3000" } }))).status).toBe(403);
  });


  it("판매자 쿠키로 마스터 API를 부르면 401", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const res = await sellerLogin(post("/api/seller/auth/login", { email: owner.email, password: PASSWORD }));
    expect(res.status).toBe(200);
    const sellerCookie = cookieOf(res).replace(/^lo_seller=/, "lo_admin=");
    expect((await adminMe(get("/api/admin/me", sellerCookie))).status).toBe(401);
  });
});

describe("HTTP: 다른 판매자 데이터 접근", () => {
  it("판매자 B 쿠키로 판매자 A 주문을 조회하면 404, A는 200", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const buyer = await createBuyer(a.seller.id, a.grade.id);
    const { order } = await createPaidOrderItem(a.seller.id, buyer.id);
    const ownerA = await createSellerUser(a.seller.id, "OWNER");
    const ownerB = await createSellerUser(b.seller.id, "OWNER");

    const login = async (email: string) => cookieOf(await sellerLogin(post("/api/seller/auth/login", { email, password: PASSWORD })));
    const params = { params: Promise.resolve({ orderId: order.id }) };

    const resB = await sellerOrder(get(`/api/seller/orders/${order.id}`, await login(ownerB.email)), params);
    expect(resB.status).toBe(404);
    const resA = await sellerOrder(get(`/api/seller/orders/${order.id}`, await login(ownerA.email)), params);
    expect(resA.status).toBe(200);
    expect((await resA.json()).id).toBe(order.id);
  });

  it("로그인하지 않으면 401", async () => {
    const res = await sellerOrder(get("/api/seller/orders/x"), { params: Promise.resolve({ orderId: "x" }) });
    expect(res.status).toBe(401);
  });
});

describe("HTTP: 구매자 로그인", () => {
  it("정지된 쇼핑몰에는 로그인할 수 없다 (404)", async () => {
    const { seller } = await createSeller();
    await db.seller.update({ where: { id: seller.id }, data: { status: "SUSPENDED" } });
    const res = await buyerLogin(post(`/api/shop/${seller.slug}/auth/login`, { loginId: "a", password: "b" }), {
      params: Promise.resolve({ slug: seller.slug }),
    });
    expect(res.status).toBe(404);
  });
});
