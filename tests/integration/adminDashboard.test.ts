import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as dashboardRoute } from "../../app/api/admin/dashboard/route";
import { adminDashboard } from "../../lib/server/admin/dashboard";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { PASSWORD, createAdmin, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 마스터 관리자 통합 대시보드 요약(MA-001)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

// 11/1 12:00 KST. 오늘 시작 = 10/31 15:00Z(11/1 0시 KST)
const NOW = new Date("2026-11-01T03:00:00Z");
const TODAY = new Date("2026-10-31T15:00:00Z");

describe("통합 대시보드 GET /api/admin/dashboard", () => {
  it("상태별 파트너스 수·방송 중·오늘(KST) 주문·결제 금액(환불 뺌)·이용 상태별 수와 연체 수", async () => {
    const plans = await seedPlans();
    const a = await createAdmin("READ_ONLY");
    const ctx = (await resolveAdminSession(db, (await createAdminSession(db, a.id, {})).token))!;
    const { seller, grade } = await createSeller();
    await db.seller.update({ where: { id: seller.id }, data: { approvedAt: new Date("2026-09-01T00:00:00Z"), trialEndsAt: null } });
    for (const status of ["PENDING", "PENDING", "SUSPENDED", "REJECTED"] as const) {
      const s = (await createSeller()).seller;
      await db.seller.update({ where: { id: s.id }, data: { status } });
    }
    // 연체(유예 중) 1곳
    await db.sellerSubscription.create({
      data: { sellerId: seller.id, planId: plans.INTEGRATED.id, status: "PAST_DUE", currentPeriodEnd: new Date("2026-10-30T00:00:00Z"), graceUntil: new Date("2026-11-05T00:00:00Z") },
    });
    await db.broadcastSession.create({ data: { sellerId: seller.id, status: "LIVE", startedAt: NOW } });
    const ended = (await createSeller()).seller;
    await db.broadcastSession.create({ data: { sellerId: ended.id, status: "ENDED", startedAt: TODAY, endedAt: NOW } });

    const buyer = await createBuyer(seller.id, grade.id);
    const order = async (createdAt: Date, extra: Record<string, unknown> = {}) => {
      const { order: o } = await createPaidOrderItem(seller.id, buyer.id);
      await db.order.update({ where: { id: o.id }, data: { createdAt, paidAt: createdAt, ...extra } });
    };
    await order(TODAY); // 0시 정각 포함
    await order(new Date(TODAY.getTime() + 3600_000), { status: "REFUNDED", refundAmount: 2000 });
    await order(new Date(TODAY.getTime() - 1)); // 어제 23:59:59.999 제외
    await order(new Date(NOW.getTime() + 1000)); // 미래(시계 뒤) 제외

    const r = await adminDashboard(db, ctx, { now: NOW });
    expect(r).toMatchObject({
      todayStart: TODAY,
      sellers: { total: 6, ACTIVE: 2, PENDING: 2, SUSPENDED: 1, REJECTED: 1, CLOSED: 0 },
      liveBroadcasts: 1,
      ordersToday: { created: 2, paid: 2, paidAmount: 8000 },
      pastDue: 1,
    });
    expect(r.subscriptions.grace).toBe(1);
    expect(await db.auditLog.count()).toBe(0);
  });

  it("마스터 관리자 전 역할이 본다(no-store), 로그인 없음·파트너스 세션은 401", async () => {
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      const a = await createAdmin(role);
      const res = await dashboardRoute(new Request("http://localhost:3000/api/admin/dashboard", { headers: { host: "localhost:3000", cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` } }));
      expect(res.status, role).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
    }
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await dashboardRoute(new Request("http://localhost:3000/api/admin/dashboard", { headers: { host: "localhost:3000", cookie: `lo_seller=${login.token}` } }))).status).toBe(401);
    expect((await dashboardRoute(new Request("http://localhost:3000/api/admin/dashboard", { headers: { host: "localhost:3000" } }))).status).toBe(401);
  });
});
