import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as ordersRoute } from "../../app/api/admin/stats/orders/route";
import { GET as growthRoute } from "../../app/api/admin/stats/growth/route";
import { GET as topRoute } from "../../app/api/admin/stats/top-sellers/route";
import { GET as subsRoute } from "../../app/api/admin/stats/subscriptions/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { PASSWORD, createAdmin, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 마스터 관리자 플랫폼 통계(조회 전용)
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const get = (path: string, cookie?: string, route = ordersRoute) =>
  route(new Request(`http://localhost:3000/api/admin/stats/${path}`, { headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } }));
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

describe("월별 구독 매출·수납 결과 GET /api/admin/stats/subscriptions", () => {
  it("월별 결제 완료 매출·실패·진행 중·환불 완료·수납률을 세고 전기와 비교한다", async () => {
    const plans = await seedPlans();
    const a = (await createSeller()).seller;
    const b = (await createSeller()).seller;
    const subA = await db.sellerSubscription.create({ data: { sellerId: a.id, planId: plans.INTEGRATED.id } });
    const subB = await db.sellerSubscription.create({ data: { sellerId: b.id, planId: plans.OVERLAY_ONLY.id } });
    const pay = (s: typeof a, sub: typeof subA, at: string, status: "PAID" | "FAILED" | "PENDING", amount: number) =>
      db.subscriptionPayment.create({
        data: { sellerId: s.id, subscriptionId: sub.id, amount, status, periodStart: new Date(at), periodEnd: new Date(new Date(at).getTime() + 30 * 86_400_000), createdAt: new Date(at), paidAt: status === "PAID" ? new Date(at) : null },
      });
    // 이번 기간 9/1~10/31(KST): 9월 결제 2건(179000·79000)·실패 1건, 10월 결제 1건·진행 중 1건
    const p1 = await pay(a, subA, "2026-09-10T03:00:00Z", "PAID", 179_000);
    await pay(b, subB, "2026-09-11T03:00:00Z", "PAID", 79_000);
    await pay(b, subB, "2026-09-12T03:00:00Z", "FAILED", 79_000);
    await pay(a, subA, "2026-10-10T03:00:00Z", "PAID", 179_000);
    await pay(b, subB, "2026-10-11T03:00:00Z", "PENDING", 79_000);
    // 10월 환불 완료 1건(9월 결제분)·실패한 환불은 세지 않는다
    await db.subscriptionRefund.create({ data: { sellerId: a.id, paymentId: p1.id, amount: 50_000, source: "SYSTEM", reason: "x", status: "REFUNDED", refundedAt: new Date("2026-10-15T03:00:00Z") } });
    await db.subscriptionRefund.create({ data: { sellerId: a.id, paymentId: p1.id, amount: 9_000, source: "SYSTEM", reason: "x", status: "FAILED" } });
    // 전기(7/2~8/31) 결제 1건
    await pay(a, subA, "2026-08-10T03:00:00Z", "PAID", 179_000);

    const res = await get("subscriptions?from=2026-09-01&to=2026-10-31", await adminCookie(), subsRoute);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range.unit).toBe("month");
    expect(body.current).toEqual({ paid: 3, failed: 1, pending: 1, revenue: 437_000, refunds: 1, refundAmount: 50_000, netRevenue: 387_000, collectionRate: 0.75 });
    expect(body.previous).toMatchObject({ paid: 1, revenue: 179_000, collectionRate: 1 });
    expect(body.series).toEqual([
      { bucket: "2026-09", paid: 2, failed: 1, pending: 0, revenue: 258_000, refunds: 0, refundAmount: 0, netRevenue: 258_000, collectionRate: 0.6667 },
      { bucket: "2026-10", paid: 1, failed: 0, pending: 1, revenue: 179_000, refunds: 1, refundAmount: 50_000, netRevenue: 129_000, collectionRate: 1 },
    ]);
  });

  it("마스터 관리자 전 역할이 보고, 잘못된 기간은 400, 파트너스 세션·무로그인은 401", async () => {
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      expect((await get("subscriptions?from=2026-09-01&to=2026-10-31", await adminCookie(role), subsRoute)).status, role).toBe(200);
    }
    expect((await get("subscriptions", await adminCookie(), subsRoute)).status).toBe(400);
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await get("subscriptions?from=2026-09-01&to=2026-10-31", `lo_seller=${login.token}`, subsRoute)).status).toBe(401);
    expect((await get("subscriptions?from=2026-09-01&to=2026-10-31", undefined, subsRoute)).status).toBe(401);
  });
});

describe("신규 파트너스·방송 수 추이 GET /api/admin/stats/growth", () => {
  it("가입 신청·승인·시작한 방송·방송한 파트너스 수를 일별로 세고(0 채움) 전기와 비교한다", async () => {
    const a = (await createSeller()).seller;
    const b = (await createSeller()).seller;
    const c = (await createSeller()).seller;
    const old = (await createSeller()).seller;
    const at = (iso: string) => new Date(iso);
    // 이번 기간 10/1~10/3(KST). a: 10/1 가입·10/2 승인, b: 10/3 가입(미승인), c: 전기(9/29) 가입·이번 기간 10/1 승인, old: 기간 밖
    await db.seller.update({ where: { id: a.id }, data: { createdAt: at("2026-10-01T03:00:00Z"), approvedAt: at("2026-10-02T03:00:00Z") } });
    await db.seller.update({ where: { id: b.id }, data: { createdAt: at("2026-10-03T03:00:00Z"), approvedAt: null } });
    await db.seller.update({ where: { id: c.id }, data: { createdAt: at("2026-09-29T03:00:00Z"), approvedAt: at("2026-10-01T05:00:00Z") } });
    await db.seller.update({ where: { id: old.id }, data: { createdAt: at("2026-08-01T03:00:00Z"), approvedAt: at("2026-08-02T03:00:00Z") } });
    const live = (sellerId: string, startedAt: string) => db.broadcastSession.create({ data: { sellerId, status: "ENDED", startedAt: at(startedAt), endedAt: at(startedAt) } });
    await live(a.id, "2026-10-01T03:00:00Z");
    await live(a.id, "2026-10-01T05:00:00Z"); // 같은 파트너스 같은 날 2번
    await live(b.id, "2026-10-03T03:00:00Z");
    await live(a.id, "2026-09-29T03:00:00Z"); // 전기
    await live(a.id, "2026-10-04T03:00:00Z"); // 기간 밖

    const res = await get("growth?from=2026-10-01&to=2026-10-03", await adminCookie(), growthRoute);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.current).toEqual({ signups: 2, approved: 2, broadcasts: 3, broadcasters: 2 });
    expect(body.previous).toEqual({ signups: 1, approved: 0, broadcasts: 1, broadcasters: 1 });
    expect(body.series).toEqual([
      { bucket: "2026-10-01", signups: 1, approved: 1, broadcasts: 2, broadcasters: 1 },
      { bucket: "2026-10-02", signups: 0, approved: 1, broadcasts: 0, broadcasters: 0 },
      { bucket: "2026-10-03", signups: 1, approved: 0, broadcasts: 1, broadcasters: 1 },
    ]);
  });

  it("마스터 관리자 전 역할이 보고, 잘못된 기간은 400, 파트너스 세션·무로그인은 401", async () => {
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      expect((await get("growth?from=2026-10-01&to=2026-10-07", await adminCookie(role), growthRoute)).status, role).toBe(200);
    }
    expect((await get("growth", await adminCookie(), growthRoute)).status).toBe(400);
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await get("growth?from=2026-10-01&to=2026-10-07", `lo_seller=${login.token}`, growthRoute)).status).toBe(401);
    expect((await get("growth?from=2026-10-01&to=2026-10-07", undefined, growthRoute)).status).toBe(401);
  });
});

describe("상위 5 파트너스 GET /api/admin/stats/top-sellers", () => {
  it("기간 안 순매출(결제−환불) 순 상위 5, 결제 없는 쇼핑몰·기간 밖 주문은 뺀다, 비중은 플랫폼 순매출 대비", async () => {
    const shops: Awaited<ReturnType<typeof createSeller>>[] = [];
    for (let i = 0; i < 7; i++) shops.push(await createSeller());
    const order = async (s: (typeof shops)[number], at: string, totalAmount: number, extra: Record<string, unknown> = {}) => {
      const buyer = await createBuyer(s.seller.id, s.grade.id);
      const { order: o } = await createPaidOrderItem(s.seller.id, buyer.id);
      await db.order.update({ where: { id: o.id }, data: { createdAt: new Date(at), paidAt: new Date(at), totalAmount, ...extra } });
    };
    const IN = "2026-10-02T03:00:00Z";
    // 순매출: 0번 50000, 1번 40000(결제 60000 − 환불 20000), 2번 30000, 3번 20000, 4번 10000, 5번 5000(6위)
    await order(shops[0], IN, 50_000);
    await order(shops[1], IN, 60_000, { status: "REFUNDED", refundAmount: 20_000 });
    await order(shops[2], IN, 30_000);
    await order(shops[3], IN, 20_000);
    await order(shops[4], IN, 10_000);
    await order(shops[5], IN, 5_000);
    // 6번: 결제 없는 주문만(결제 대기) → 제외, 0번: 기간 밖 큰 주문 → 제외
    const b6 = await createBuyer(shops[6].seller.id, shops[6].grade.id);
    const { order: pending } = await createPaidOrderItem(shops[6].seller.id, b6.id);
    await db.order.update({ where: { id: pending.id }, data: { createdAt: new Date(IN), paidAt: null, status: "PENDING_PAYMENT" } });
    await order(shops[0], "2026-11-20T03:00:00Z", 900_000);

    const res = await get("top-sellers?from=2026-10-01&to=2026-10-31", await adminCookie(), topRoute);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.platformNetRevenue).toBe(50_000 + 40_000 + 30_000 + 20_000 + 10_000 + 5_000);
    expect(body.rows.map((r: { sellerId: string }) => r.sellerId)).toEqual(shops.slice(0, 5).map((s) => s.seller.id));
    expect(body.rows[1]).toMatchObject({ rank: 2, shopName: shops[1].seller.shopName, slug: shops[1].seller.slug, orders: 1, paidOrders: 1, revenue: 60_000, refundAmount: 20_000, netRevenue: 40_000 });
    expect(body.rows[0].share).toBeCloseTo(50_000 / 155_000, 4);
    expect(Object.keys(body.rows[0]).sort()).toEqual(["orders", "paidOrders", "rank", "refundAmount", "revenue", "sellerId", "share", "shopName", "slug", "netRevenue"].sort());
  });

  it("마스터 관리자 전 역할이 보고, 잘못된 기간은 400, 파트너스 세션·무로그인은 401", async () => {
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      const res = await get("top-sellers?from=2026-10-01&to=2026-10-07", await adminCookie(role), topRoute);
      expect(res.status, role).toBe(200);
      expect((await res.json()).rows).toEqual([]);
    }
    expect((await get("top-sellers", await adminCookie(), topRoute)).status).toBe(400);
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await get("top-sellers?from=2026-10-01&to=2026-10-07", `lo_seller=${login.token}`, topRoute)).status).toBe(401);
    expect((await get("top-sellers?from=2026-10-01&to=2026-10-07", undefined, topRoute)).status).toBe(401);
  });
});
