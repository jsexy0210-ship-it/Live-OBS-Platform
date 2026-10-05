import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as ordersRoute } from "../../app/api/admin/stats/orders/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { PASSWORD, createAdmin, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 마스터 관리자 플랫폼 통계(조회 전용)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const get = (path: string, cookie?: string) =>
  ordersRoute(new Request(`http://localhost:3000/api/admin/stats/${path}`, { headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } }));
const adminCookie = async (role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "READ_ONLY") =>
  `lo_admin=${(await createAdminSession(db, (await createAdmin(role)).id, {})).token}`;

describe("플랫폼 일별 주문·결제 GET /api/admin/stats/orders", () => {
  it("여러 파트너스의 주문을 합산하고(일별 0 채움), 전기와 비교한다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const order = async (s: typeof a, at: string, extra: Record<string, unknown> = {}) => {
      const buyer = await createBuyer(s.seller.id, s.grade.id);
      const { order: o } = await createPaidOrderItem(s.seller.id, buyer.id);
      await db.order.update({ where: { id: o.id }, data: { createdAt: new Date(at), paidAt: new Date(at), ...extra } });
      return o;
    };
    // 이번 기간 10/1~10/3(KST). 10/2 3시(KST)=10/1 18:00Z
    await order(a, "2026-10-01T03:00:00Z");
    await order(b, "2026-10-01T05:00:00Z");
    await order(b, "2026-10-03T03:00:00Z", { status: "REFUNDED", refundAmount: 1000 });
    // 전기 9/28~9/30
    await order(a, "2026-09-29T03:00:00Z");
    // 기간 밖
    await order(a, "2026-10-04T03:00:00Z");

    const res = await get("orders?from=2026-10-01&to=2026-10-03", await adminCookie());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.range).toMatchObject({ from: "2026-10-01", to: "2026-10-03", unit: "day", previous: { from: "2026-09-28", to: "2026-09-30" } });
    expect(body.current).toMatchObject({ orders: 3, paidOrders: 3, refunded: 1, refundAmount: 1000 });
    expect(body.previous).toMatchObject({ orders: 1, paidOrders: 1 });
    expect(body.series.map((p: { bucket: string }) => p.bucket)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(body.series.map((p: { orders: number }) => p.orders)).toEqual([2, 0, 1]);
    expect(body.series.reduce((x: number, p: { revenue: number }) => x + p.revenue, 0)).toBe(body.current.revenue);
  });

  it("마스터 관리자 전 역할이 보고, 잘못된 기간은 400, 로그인 없음·파트너스 세션은 401", async () => {
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      expect((await get("orders?from=2026-10-01&to=2026-10-07", await adminCookie(role))).status, role).toBe(200);
    }
    expect((await get("orders?from=2026-10-07&to=2026-10-01", await adminCookie())).status).toBe(400);
    expect((await get("orders", await adminCookie())).status).toBe(400);
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await get("orders?from=2026-10-01&to=2026-10-07", `lo_seller=${login.token}`)).status).toBe(401);
    expect((await get("orders?from=2026-10-01&to=2026-10-07")).status).toBe(401);
  });
});
