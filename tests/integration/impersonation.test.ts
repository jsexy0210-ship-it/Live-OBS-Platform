import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as endRoute, GET as activeRoute } from "../../app/api/admin/impersonation/route";
import { POST as startRoute } from "../../app/api/admin/sellers/[sellerId]/impersonate/route";
import { GET as meRoute } from "../../app/api/seller/me/route";
import { GET as sellerImpRoute } from "../../app/api/seller/impersonation/route";
import { GET as ordersRoute } from "../../app/api/seller/orders/route";
import { GET as orderOne } from "../../app/api/seller/orders/[orderId]/route";
import { GET as productsGet, POST as productsPost } from "../../app/api/seller/products/route";
import { GET as subscriptionGet } from "../../app/api/seller/subscription/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { proxy } from "../../proxy";
import { createAdmin, createBuyer, createSeller, db, resetDb } from "./helpers";

// 마스터 대리 조회(MA-016): 권한·사유·로그 추적, 읽기 전용(경로 안전망 proxy + 가드), 쇼핑몰 격리, 끝내기·만료·관리자 정지 시 차단.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const sid = (sellerId: string) => ({ params: Promise.resolve({ sellerId }) });
const oid = (orderId: string) => ({ params: Promise.resolve({ orderId }) });
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function start(cookie: string, sellerId: string, body: unknown = { reason: "고객 문의 확인" }) {
  const res = await startRoute(req(`/api/admin/sellers/${sellerId}/impersonate`, cookie, "POST", body), sid(sellerId));
  return { res, status: res.status, body: await res.json(), imp: /lo_imp=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] };
}
async function shopWithOrder(name: string) {
  const { seller, grade } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { shopName: name } });
  const buyer = await createBuyer(seller.id, grade.id);
  const order = await db.order.create({ data: { sellerId: seller.id, orderNo: 1, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 10000 } });
  return { seller, order };
}

describe("대리 조회 시작 POST /api/admin/sellers/{id}/impersonate", () => {
  it("최고관리자·운영·CS만, 조회 전용 403·비로그인 401. 사유 필수(1~200자). 쿠키는 /api/seller 경로 전용. 열 때 로그 추적에 남는다", async () => {
    const { seller } = await shopWithOrder("가게");
    for (const role of ["READ_ONLY"] as const) expect((await start((await admin(role)).cookie, seller.id)).status).toBe(403);
    expect((await start("", seller.id)).status).toBe(401);
    const su = await admin("SUPER_ADMIN");
    for (const bad of [{}, { reason: "  " }, { reason: 12 }, { reason: "가".repeat(201) }]) {
      expect(await start(su.cookie, seller.id, bad)).toMatchObject({ status: 400, body: { error: "reason_required" } });
    }
    expect((await start(su.cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await start(su.cookie, "not-a-uuid")).status).toBe(404);
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS"] as const) {
      const a = await admin(role);
      const r = await start(a.cookie, seller.id);
      expect(r).toMatchObject({ status: 200, body: { ok: true, seller: { id: seller.id, shopName: "가게" } } });
      const setCookie = r.res.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("lo_imp=imp.");
      expect(setCookie).toMatch(/Path=\/api\/seller/i);
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=strict/i);
    }
    const logs = await db.auditLog.findMany({ where: { action: "admin.impersonate.view" } });
    expect(logs).toHaveLength(3);
    expect(logs[0]).toMatchObject({ actorType: "PLATFORM_ADMIN", sellerId: seller.id, reason: "고객 문의 확인" });
    // 토큰 원문은 DB에 없다
    const row = await db.adminImpersonationSession.findFirstOrThrow();
    expect(row.tokenHash).not.toContain("imp.");
  });

  it("승인 대기·거절·종료 쇼핑몰은 409. 새로 열면 앞의 세션은 끝난다", async () => {
    const su = await admin("SUPER_ADMIN");
    const pending = await db.seller.create({ data: { slug: "pending-x", shopName: "대기", status: "PENDING" } });
    expect((await start(su.cookie, pending.id)).body.error).toBe("seller_not_viewable");
    const a = await shopWithOrder("가");
    const b = await shopWithOrder("나");
    const first = await start(su.cookie, a.seller.id);
    const second = await start(su.cookie, b.seller.id);
    expect((await ordersRoute(req("/api/seller/orders", `lo_imp=${first.imp}`))).status).toBe(401);
    expect((await ordersRoute(req("/api/seller/orders", `lo_imp=${second.imp}`))).status).toBe(200);
    expect(await db.adminImpersonationSession.count({ where: { endedAt: null } })).toBe(1);
    const replaced = await db.auditLog.findMany({ where: { action: "admin.impersonate.end", sellerId: a.seller.id } });
    expect(replaced.map((l) => (l.after as { cause: string }).cause)).toEqual(["replaced"]);
  });
});

describe("대리 조회 중 파트너스 API", () => {
  it("대상 쇼핑몰의 주문·상품만 읽고, 다른 쇼핑몰 주문은 못 본다. 구독·직원 같은 조회 권한 밖은 403, 변경은 403", async () => {
    const su = await admin("SUPER_ADMIN");
    const a = await shopWithOrder("가");
    const b = await shopWithOrder("나");
    const { imp } = await start(su.cookie, a.seller.id);
    const cookie = `lo_imp=${imp}`;
    const list = await ordersRoute(req("/api/seller/orders", cookie));
    expect(list.status).toBe(200);
    const text = JSON.stringify(await list.json());
    expect(text).toContain(a.order.id);
    expect(text).not.toContain(b.order.id);
    expect((await orderOne(req(`/api/seller/orders/${a.order.id}`, cookie), oid(a.order.id))).status).toBe(200);
    expect((await orderOne(req(`/api/seller/orders/${b.order.id}`, cookie), oid(b.order.id))).status).toBe(404);
    expect((await productsGet(req("/api/seller/products", cookie))).status).toBe(200);
    expect((await subscriptionGet(req("/api/seller/subscription", cookie))).status).toBe(403);
    expect((await productsPost(req("/api/seller/products", cookie, "POST", { name: "x", price: 1000 }))).status).toBe(403);
    expect(await db.product.count()).toBe(0);
    const me = await (await sellerImpRoute(req("/api/seller/impersonation", cookie))).json();
    expect(me).toMatchObject({ active: true, readOnly: true, seller: { id: a.seller.id }, reason: "고객 문의 확인" });
  });

  it("끝내면 쿠키가 있어도 401, 로그 추적에 끝남이 남는다. 만료·관리자 정지·쇼핑몰 닫힘도 401", async () => {
    const su = await admin("SUPER_ADMIN");
    const a = await shopWithOrder("가");
    const { imp } = await start(su.cookie, a.seller.id);
    const cookie = `lo_imp=${imp}`;
    expect((await json(await activeRoute(req("/api/admin/impersonation", su.cookie)))).body.active).toMatchObject({ sellerId: a.seller.id, reason: "고객 문의 확인" });
    expect((await ordersRoute(req("/api/seller/orders", cookie))).status).toBe(200);
    const endRes = await endRoute(req("/api/admin/impersonation", su.cookie, "DELETE"));
    expect(await json(endRes.clone())).toMatchObject({ status: 200, body: { ok: true, ended: 1 } });
    // 관리자 끝내기 응답이 /api/seller 경로의 lo_imp를 직접 만료시킨다(HttpOnly라 화면이 못 지움)
    const clear = endRes.headers.get("set-cookie") ?? "";
    expect(clear).toMatch(/lo_imp=;/);
    expect(clear).toMatch(/Path=\/api\/seller/i);
    expect(clear).toMatch(/Max-Age=0/i);
    expect((await ordersRoute(req("/api/seller/orders", cookie))).status).toBe(401);
    expect((await json(await activeRoute(req("/api/admin/impersonation", su.cookie)))).body.active).toBeNull();
    const endLogs = () => db.auditLog.findMany({ where: { action: "admin.impersonate.end", sellerId: a.seller.id }, orderBy: { createdAt: "asc" } });
    expect((await endLogs()).map((l) => (l.after as { cause: string }).cause)).toEqual(["manual"]);

    const s2 = await start(su.cookie, a.seller.id);
    await db.adminImpersonationSession.updateMany({ where: { endedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await ordersRoute(req("/api/seller/orders", `lo_imp=${s2.imp}`))).status).toBe(401);
    expect((await ordersRoute(req("/api/seller/orders", `lo_imp=${s2.imp}`))).status).toBe(401);
    // 만료는 처음 알아챈 때 한 번만 로그 추적에 남는다
    expect((await endLogs()).map((l) => (l.after as { cause: string }).cause)).toEqual(["manual", "expired"]);

    const s3 = await start(su.cookie, a.seller.id);
    await db.platformAdmin.update({ where: { id: su.id }, data: { status: "SUSPENDED" } });
    expect((await ordersRoute(req("/api/seller/orders", `lo_imp=${s3.imp}`))).status).toBe(401);
    await db.platformAdmin.update({ where: { id: su.id }, data: { status: "ACTIVE" } });
    expect((await ordersRoute(req("/api/seller/orders", `lo_imp=${s3.imp}`))).status).toBe(200);
    await db.seller.update({ where: { id: a.seller.id }, data: { status: "CLOSED" } });
    expect((await ordersRoute(req("/api/seller/orders", `lo_imp=${s3.imp}`))).status).toBe(401);
  });

  it("가짜 토큰·파트너스 쿠키 이름으로 imp 토큰을 넣어도 통하지 않는다", async () => {
    const a = await shopWithOrder("가");
    expect((await ordersRoute(req("/api/seller/orders", "lo_imp=imp.fake"))).status).toBe(401);
    expect((await ordersRoute(req("/api/seller/orders", "lo_seller=imp.fake"))).status).toBe(401);
    expect(a.order.id).toBeTruthy();
  });
});

describe("화면 틀이 읽는 내 정보 GET /api/seller/me (대리 조회)", () => {
  it("proxy를 통과해 200으로 열리고, 어느 쇼핑몰을 누가 왜 보는지 내려준다. 다른 쇼핑몰 파트너스 로그인 쿠키가 같이 있어도 대리 조회 쇼핑몰이 우선이다", async () => {
    const { seller } = await shopWithOrder("시험 결제몰");
    const other = await createSeller();
    const su = await admin("SUPER_ADMIN");
    const { imp } = await start(su.cookie, seller.id, { reason: "결제 문의 확인" });
    const cookie = `lo_imp=${imp}`;
    const through = await proxy(new NextRequest(BASE + "/api/seller/me", { headers: { cookie } }));
    expect(through.headers.get("x-middleware-next")).toBe("1");
    const r = await json(await meRoute(req("/api/seller/me", cookie)));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ sellerId: seller.id, isOwner: false, readOnly: true, shop: { name: "시험 결제몰" }, impersonation: { reason: "결제 문의 확인" } });
    expect(r.body.permissions.sort()).toEqual(["MEMBER_POINTS", "ORDER_SHIPPING", "PRODUCT_MANAGE", "SALES_VIEW"]);
    expect(r.body.impersonation.adminName).toBe(r.body.user.name);
    // 다른 쇼핑몰의 파트너스 세션 쿠키가 같이 와도 대리 조회 쇼핑몰이 우선
    const both = await json(await meRoute(req("/api/seller/me", `lo_seller=${"x".repeat(20)}; ${cookie}`)));
    expect(both.body.sellerId).toBe(seller.id);
    expect(other.seller.id).not.toBe(seller.id);
    // 끝내면 401
    await endRoute(req("/api/admin/impersonation", su.cookie, "DELETE"));
    expect((await meRoute(req("/api/seller/me", cookie))).status).toBe(401);
  });
});

describe("proxy 안전망(대리 조회 쿠키가 있는 /api/seller 요청)", () => {
  const hit = async (method: string, path: string, cookie?: string) => {
    const res = await proxy(new NextRequest(BASE + path, { method, headers: cookie ? { cookie } : {} }));
    return res.headers.get("x-middleware-next") === "1" ? { kind: "pass" as const } : { kind: "blocked" as const, status: res.status, body: await res.json() };
  };
  it("조회 허용 경로의 GET·HEAD만 통과하고 나머지는 403 impersonation_read_only", async () => {
    const c = "lo_imp=imp.abc";
    for (const p of ["/api/seller/orders", "/api/seller/orders/xyz", "/api/seller/members", "/api/seller/products", "/api/seller/products/xyz", "/api/seller/stats/sales", "/api/seller/impersonation", "/api/seller/me"]) {
      expect(await hit("GET", p, c)).toEqual({ kind: "pass" });
    }
    expect(await hit("HEAD", "/api/seller/orders", c)).toEqual({ kind: "pass" });
    for (const [m, p] of [
      ["POST", "/api/seller/orders"],
      ["PATCH", "/api/seller/products/xyz"],
      ["DELETE", "/api/seller/members/xyz"],
      ["GET", "/api/seller/staff"],
      ["GET", "/api/seller/subscription"],
      ["GET", "/api/seller/notifications"],
      ["GET", "/api/seller/orders-evil"],
      ["GET", "/api/seller/me/password"],
      ["GET", "/api/seller/me-evil"],
      ["POST", "/api/seller/me"],
      ["POST", "/api/seller/auth/login"],
    ] as const) {
      expect(await hit(m, p, c)).toMatchObject({ kind: "blocked", status: 403, body: { error: "impersonation_read_only" } });
    }
  });
  it("쿠키가 없으면 건드리지 않고, 마스터 API·화면은 쿠키가 있어도 건드리지 않는다", async () => {
    expect(await hit("POST", "/api/seller/orders")).toEqual({ kind: "pass" });
    expect(await hit("GET", "/api/seller/staff", "lo_seller=abc")).toEqual({ kind: "pass" });
    expect(await hit("POST", "/api/admin/impersonation", "lo_imp=imp.abc")).toEqual({ kind: "pass" });
  });
});

async function json(r: Response) {
  return { status: r.status, body: await r.json() };
}
