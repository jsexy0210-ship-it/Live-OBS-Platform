import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as pgStatusRoute } from "../../app/api/admin/pg-status/route";
import { GET as billingRoute } from "../../app/api/admin/subscription-billing/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { FakePaymentGateway } from "../../lib/server/payments/gateway";
import { paymentFailureMessage } from "../../lib/server/payments/adminStatus";
import { setPaymentGatewayForTest } from "../../lib/server/payments/registry";
import { PASSWORD, createAdmin, createBuyer, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 마스터 관리자 결제 조회(MASTER 배정 2026-10-05): MA-031 PG 연결 상태, MA-032 구독료 수납 현황. 조회만, 모든 마스터 역할.
beforeEach(resetDb);
afterEach(() => setPaymentGatewayForTest(undefined));
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { host: "localhost:3000" };
const HOUR = 3_600_000;
async function adminCookie(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "READ_ONLY") {
  const a = await createAdmin(role);
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
const get = (route: (r: Request) => Promise<Response>, path: string, cookie: string) => route(new Request(`http://localhost:3000${path}`, { headers: { ...H, cookie } }));

async function shopWithPayments(name: string, payments: { status: "PAID" | "FAILED"; at: Date; code?: string }[], cancels: ("REQUESTED" | "FAILED" | "DONE")[] = []) {
  const { seller, grade } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { shopName: name } });
  const buyer = await createBuyer(seller.id, grade.id);
  let n = 0;
  const ids: string[] = [];
  for (const p of payments) {
    const order = await db.order.create({ data: { sellerId: seller.id, orderNo: ++n, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 10000 } });
    const row = await db.payment.create({
      data: {
        sellerId: seller.id,
        orderId: order.id,
        provider: "nicepay",
        method: "CARD",
        status: p.status,
        amount: 10000,
        approvedAt: p.status === "PAID" ? p.at : null,
        failureCode: p.code ?? null,
        updatedAt: p.at,
      },
    });
    ids.push(row.id);
  }
  for (const [i, status] of cancels.entries()) {
    await db.paymentCancel.create({ data: { sellerId: seller.id, paymentId: ids[0], amount: 100, reason: "x", idempotencyKey: `k${i}`, status } });
  }
  return seller;
}

describe("PG 연결 상태 GET /api/admin/pg-status", () => {
  it("파트너스별 최근 성공·실패와 실패 문구, 24시간 실패 수, 취소 대기·실패 수. 최근 실패가 있는 파트너스 먼저", async () => {
    setPaymentGatewayForTest(new FakePaymentGateway());
    const now = Date.now();
    const a = await shopWithPayments("가게A", [
      { status: "PAID", at: new Date(now - 5 * HOUR) },
      { status: "FAILED", at: new Date(now - 1 * HOUR), code: "nicepay_3095" },
      { status: "FAILED", at: new Date(now - 30 * HOUR), code: "nicepay_3021" },
    ], ["REQUESTED", "FAILED", "DONE"]);
    const b = await shopWithPayments("가게B", [{ status: "PAID", at: new Date(now - 2 * HOUR) }]);
    const c = await shopWithPayments("가게C", [{ status: "FAILED", at: new Date(now - 10 * HOUR), code: "amount_mismatch" }]);
    await createSeller(); // 결제가 없는 파트너스는 목록에 없다

    const r = await get(pgStatusRoute, "/api/admin/pg-status", await adminCookie());
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const body = await r.json();
    expect(body.gateway).toMatchObject({ provider: "nicepay", configured: true, mode: "sandbox", lastFailureCode: "nicepay_3095", lastFailureMessage: "카드사에서 승인을 거절했습니다(한도 초과·정지 카드 등)" });
    expect(body.sellers.map((s: { seller: { id: string } }) => s.seller.id)).toEqual([a.id, c.id, b.id]);
    expect(body.sellers[0]).toMatchObject({
      seller: { shopName: "가게A" },
      lastFailureCode: "nicepay_3095",
      failures24h: 1,
      cancelsPending: 1,
      cancelsFailed: 1,
      lastSuccessAt: expect.any(String),
    });
    expect(body.sellers[1]).toMatchObject({ lastFailureCode: "amount_mismatch", lastFailureMessage: "결제 금액이 주문 금액과 달라 승인하지 않았습니다", lastSuccessAt: null });
    expect(body.sellers[2]).toMatchObject({ lastFailureAt: null, lastFailureCode: null, lastFailureMessage: null, failures24h: 0 });
    expect(body.nextCursor).toBeNull();

    // 검색·쪽 나누기
    const q = await (await get(pgStatusRoute, `/api/admin/pg-status?q=${encodeURIComponent("게B")}`, await adminCookie())).json();
    expect(q.sellers.map((s: { seller: { id: string } }) => s.seller.id)).toEqual([b.id]);
    const p1 = await (await get(pgStatusRoute, "/api/admin/pg-status?limit=2", await adminCookie())).json();
    expect(p1.sellers).toHaveLength(2);
    expect(p1.nextCursor).toBe("2");
    const p2 = await (await get(pgStatusRoute, `/api/admin/pg-status?limit=2&cursor=${p1.nextCursor}`, await adminCookie())).json();
    expect(p2.sellers.map((s: { seller: { id: string } }) => s.seller.id)).toEqual([b.id]);
    for (const bad of ["?limit=0", "?cursor=x", `?q=${"가".repeat(51)}`]) expect((await get(pgStatusRoute, `/api/admin/pg-status${bad}`, await adminCookie())).status, bad).toBe(400);
  });

  it("키가 없으면 configured: false이고 키 값은 어디에도 내려주지 않는다. 모든 마스터 역할이 보고, 파트너스 세션은 막힌다", async () => {
    const prev = { c: process.env.NICEPAY_CLIENT_KEY, s: process.env.NICEPAY_SECRET_KEY };
    try {
      setPaymentGatewayForTest(null);
      const none = await (await get(pgStatusRoute, "/api/admin/pg-status", await adminCookie())).json();
      expect(none.gateway.configured).toBe(false);
      setPaymentGatewayForTest(undefined);
      process.env.NICEPAY_CLIENT_KEY = "test-client-value-xyz";
      process.env.NICEPAY_SECRET_KEY = "test-secret-value-xyz";
      for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
        const r = await get(pgStatusRoute, "/api/admin/pg-status", await adminCookie(role));
        expect(r.status, role).toBe(200);
        const raw = await r.text();
        expect(JSON.parse(raw).gateway.configured).toBe(true);
        expect(raw).not.toContain("test-client-value-xyz");
        expect(raw).not.toContain("test-secret-value-xyz");
      }
    } finally {
      process.env.NICEPAY_CLIENT_KEY = prev.c;
      process.env.NICEPAY_SECRET_KEY = prev.s;
      if (prev.c === undefined) delete process.env.NICEPAY_CLIENT_KEY;
      if (prev.s === undefined) delete process.env.NICEPAY_SECRET_KEY;
    }
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const l = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!l.ok) throw new Error(l.reason);
    expect((await get(pgStatusRoute, "/api/admin/pg-status", `lo_seller=${l.token}`)).status).toBe(401);
    expect((await get(billingRoute, "/api/admin/subscription-billing", `lo_seller=${l.token}`)).status).toBe(401);
  });

  it("실패 코드 문구: 정한 코드는 그 문구, 모르는 나이스페이 코드·서버 코드는 일반 문구", () => {
    expect(paymentFailureMessage("nicepay_3011")).toBe("카드 번호가 맞지 않습니다");
    expect(paymentFailureMessage("nicepay_U128")).toBe("시험 결제 환경은 부분 취소를 지원하지 않습니다. 운영 환경에서는 가능합니다.");
    expect(paymentFailureMessage("nicepay_9999")).toBe("결제사에서 승인을 거절했습니다");
    expect(paymentFailureMessage("something_new")).toBe("결제가 완료되지 않았습니다");
    expect(paymentFailureMessage(null)).toBeNull();
  });
});

describe("구독료 수납 현황 GET /api/admin/subscription-billing", () => {
  it("기간(KST 날짜, 청구 시각)의 청구·성공·실패·대기 건수와 금액, 날짜별 집계, 재시도·연체·유예 구독 수", async () => {
    const plans = await seedPlans();
    const mk = async (sub: Record<string, unknown>) => {
      const { seller } = await createSeller();
      await db.seller.update({ where: { id: seller.id }, data: { approvedAt: new Date("2026-09-01T00:00:00Z"), trialEndsAt: null, planId: plans.INTEGRATED.id } });
      return db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plans.INTEGRATED.id, subscribedAt: new Date("2026-09-01T00:00:00Z"), ...sub } });
    };
    const s1 = await mk({ status: "ACTIVE" });
    const s2 = await mk({ status: "PAST_DUE", retryCount: 2, currentPeriodEnd: new Date(Date.now() - 86_400_000), graceUntil: new Date(Date.now() + 5 * 86_400_000) });
    const pay = (sub: { id: string; sellerId: string }, status: "PAID" | "FAILED" | "PENDING", amount: number, createdAt: string) =>
      db.subscriptionPayment.create({
        data: {
          sellerId: sub.sellerId,
          subscriptionId: sub.id,
          amount,
          status,
          periodStart: new Date(createdAt),
          periodEnd: new Date(new Date(createdAt).getTime() + 30 * 86_400_000),
          paidAt: status === "PAID" ? new Date(createdAt) : null,
          createdAt: new Date(createdAt),
        },
      });
    // KST 10/01 00:30 = UTC 09/30 15:30 → 10/01로 센다
    await pay(s1, "PAID", 199000, "2026-09-30T15:30:00Z");
    await pay(s2, "FAILED", 199000, "2026-10-01T03:00:00Z");
    await pay(s2, "PENDING", 199000, "2026-10-02T03:00:00Z");
    await pay(s1, "PAID", 69000, "2026-10-02T05:00:00Z");
    await pay(s1, "PAID", 1, "2026-09-30T14:59:00Z"); // KST 09/30 23:59, 기간 밖

    const r = await get(billingRoute, "/api/admin/subscription-billing?from=2026-10-01&to=2026-10-02", await adminCookie("CS"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.range).toEqual({ from: "2026-10-01", to: "2026-10-02" });
    expect(body.summary).toEqual({ charged: 4, paid: 2, failed: 1, pending: 1, paidAmount: 268000, failedAmount: 199000, retrying: 1, pastDue: 1, grace: 1 });
    expect(body.daily).toEqual([
      { date: "2026-10-01", charged: 2, paid: 1, failed: 1, paidAmount: 199000 },
      { date: "2026-10-02", charged: 2, paid: 1, failed: 0, paidAmount: 69000 },
    ]);
    for (const bad of ["?from=2026-10-05&to=2026-10-01", "?from=2025-01-01&to=2026-10-01", "?from=10-01"]) {
      expect((await get(billingRoute, `/api/admin/subscription-billing${bad}`, await adminCookie())).status, bad).toBe(400);
    }
  });
});
