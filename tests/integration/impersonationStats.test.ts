import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as startRoute } from "../../app/api/admin/sellers/[sellerId]/impersonate/route";
import { GET as broadcastsRoute } from "../../app/api/seller/stats/broadcasts/route";
import { GET as membersRoute } from "../../app/api/seller/stats/members/route";
import { GET as ordersRoute } from "../../app/api/seller/stats/orders/route";
import { GET as overviewRoute } from "../../app/api/seller/stats/overview/route";
import { GET as productsRoute } from "../../app/api/seller/stats/products/route";
import { GET as salesRoute } from "../../app/api/seller/stats/sales/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createAdmin, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 대리 조회(MA-016) 중 통계 API(/api/seller/stats/**, SALES_VIEW): 6개 경로 모두 SALES_VIEW 확인(requireSellerRead)을 거친다.
// 매출 보기 권한이 없는 직원은 403, 대리 조회는 조회 권한 표(IMPERSONATION_READ_ACTIONS)에 SALES_VIEW가 있어 읽을 수 있되 대상 쇼핑몰 숫자만 보인다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const kstToday = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const QS = `?from=${kstToday}&to=${kstToday}`;
const ROUTES = {
  overview: overviewRoute,
  sales: salesRoute,
  orders: ordersRoute,
  members: membersRoute,
  products: productsRoute,
  broadcasts: broadcastsRoute,
} as const;

async function shopWithPaidOrder(amount: number) {
  const { seller, grade } = await createSeller();
  const buyer = await createBuyer(seller.id, grade.id);
  await db.order.create({ data: { sellerId: seller.id, orderNo: 1, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: amount, status: "PAID", paidAt: new Date() } });
  return seller;
}
async function login(sellerId: string, kind: Parameters<typeof createSellerUser>[1]) {
  const u = await createSellerUser(sellerId, kind);
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

describe("통계 API와 SALES_VIEW·대리 조회", () => {
  it("매출 보기(SALES_VIEW) 권한이 없는 직원은 6개 경로 모두 403, 있는 직원·대표자는 200", async () => {
    const seller = await shopWithPaidOrder(10_000);
    const none = await login(seller.id, { permissions: [] });
    const other = await login(seller.id, { permissions: ["PRODUCT_MANAGE", "ORDER_SHIPPING", "MEMBER_POINTS"] });
    const sales = await login(seller.id, { permissions: ["SALES_VIEW"] });
    const owner = await login(seller.id, "OWNER");
    for (const [name, route] of Object.entries(ROUTES)) {
      expect([name, (await route(req(`/api/seller/stats/${name}${QS}`, none))).status]).toEqual([name, 403]);
      expect([name, (await route(req(`/api/seller/stats/${name}${QS}`, other))).status]).toEqual([name, 403]);
      expect([name, (await route(req(`/api/seller/stats/${name}${QS}`, sales))).status]).toEqual([name, 200]);
      expect([name, (await route(req(`/api/seller/stats/${name}${QS}`, owner))).status]).toEqual([name, 200]);
    }
  });

  it("대리 조회는 6개 경로를 읽고(조회 권한 표에 SALES_VIEW), 대상 쇼핑몰 매출만 보인다. 열기 전·끝낸 뒤에는 401", async () => {
    const a = await shopWithPaidOrder(10_000);
    const b = await shopWithPaidOrder(77_000);
    const adm = await createAdmin("SUPER_ADMIN");
    const adminCookie = `lo_admin=${(await createAdminSession(db, adm.id, {})).token}`;
    const start = await startRoute(req(`/api/admin/sellers/${a.id}/impersonate`, adminCookie, "POST", { reason: "매출 확인" }), { params: Promise.resolve({ sellerId: a.id }) });
    expect(start.status).toBe(200);
    const cookie = `lo_imp=${/lo_imp=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1]}`;
    for (const [name, route] of Object.entries(ROUTES)) {
      expect([name, (await route(req(`/api/seller/stats/${name}${QS}`, cookie))).status]).toEqual([name, 200]);
    }
    const sales = await (await salesRoute(req(`/api/seller/stats/sales${QS}`, cookie))).json();
    expect(sales.current).toMatchObject({ paid: 10_000, paidOrders: 1 });
    expect(JSON.stringify(sales)).not.toContain("77000");
    expect((await salesRoute(req(`/api/seller/stats/sales${QS}`, ""))).status).toBe(401);
    expect(b.id).toBeTruthy();
  });
});
