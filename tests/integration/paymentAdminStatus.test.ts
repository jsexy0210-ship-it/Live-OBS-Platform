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

  it("쇼핑몰별 인덱스 조회로 바꾼 집계가 전체를 훑는 참조 계산과 같다(여러 쇼핑몰·같은 시각 실패·취소 상태·정렬·검색·쪽 이동·게이트웨이 요약)", async () => {
    setPaymentGatewayForTest(new FakePaymentGateway());
    const now = Date.now();
    // 같은 시각 실패 두 건(마지막 실패 코드는 id가 큰 쪽), 성공만·실패만·섞인·결제 없음, 24시간 안팎 실패, 취소 상태 섞임
    const tie = new Date(now - 3 * HOUR);
    const shops = [
      await shopWithPayments("참조A", [{ status: "FAILED", at: tie, code: "pg_failed" }, { status: "FAILED", at: tie, code: "pg_expired" }, { status: "PAID", at: new Date(now - 9 * HOUR) }], ["REQUESTED", "REQUESTED", "FAILED"]),
      await shopWithPayments("참조B", [{ status: "PAID", at: new Date(now - 1 * HOUR) }, { status: "PAID", at: new Date(now - 7 * HOUR) }], ["DONE"]),
      await shopWithPayments("참조C", [{ status: "FAILED", at: new Date(now - 26 * HOUR), code: "nicepay_3095" }, { status: "FAILED", at: new Date(now - 2 * HOUR), code: "approve_timeout" }]),
      await shopWithPayments("참조D", [{ status: "FAILED", at: tie, code: "duplicate_payment" }, { status: "PAID", at: new Date(now - 30 * HOUR) }], ["FAILED", "FAILED"]),
    ];
    await createSeller(); // 결제 없음
    // 참조: 전체 결제·취소를 읽어 쇼핑몰마다 자바스크립트로 계산
    const pays = await db.payment.findMany({ select: { id: true, sellerId: true, status: true, approvedAt: true, updatedAt: true, failureCode: true } });
    const cancels = await db.paymentCancel.findMany({ select: { sellerId: true, status: true } });
    const cmpFail = (a: { updatedAt: Date; id: string }, b: { updatedAt: Date; id: string }) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1);
    const failed = pays.filter((x) => x.status === "FAILED").sort(cmpFail);
    const sellers = await db.seller.findMany({ where: { id: { in: shops.map((x) => x.id) } }, select: { id: true, shopName: true, slug: true, status: true } });
    const ref = sellers
      .map((se) => {
        const mine = pays.filter((x) => x.sellerId === se.id);
        const fails = mine.filter((x) => x.status === "FAILED").sort(cmpFail);
        const oks = mine.map((x) => x.approvedAt).filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime());
        return {
          id: se.id,
          lastSuccessAt: oks[0]?.toISOString() ?? null,
          lastFailureAt: fails[0]?.updatedAt.toISOString() ?? null,
          lastFailureCode: fails[0]?.failureCode ?? null,
          failures24h: fails.filter((x) => x.updatedAt.getTime() > now - 24 * HOUR).length,
          cancelsPending: cancels.filter((c) => c.sellerId === se.id && c.status === "REQUESTED").length,
          cancelsFailed: cancels.filter((c) => c.sellerId === se.id && c.status === "FAILED").length,
        };
      })
      .sort((a, b) => {
        const f = (x: string | null) => (x ? Date.parse(x) : -Infinity);
        return f(b.lastFailureAt) - f(a.lastFailureAt) || f(b.lastSuccessAt) - f(a.lastSuccessAt) || (a.id < b.id ? -1 : 1);
      });
    const body = await (await get(pgStatusRoute, "/api/admin/pg-status?limit=200", await adminCookie())).json();
    type Row = { seller: { id: string }; lastSuccessAt: string | null; lastFailureAt: string | null; lastFailureCode: string | null; failures24h: number; cancelsPending: number; cancelsFailed: number };
    expect((body.sellers as Row[]).map((r) => ({ id: r.seller.id, lastSuccessAt: r.lastSuccessAt, lastFailureAt: r.lastFailureAt, lastFailureCode: r.lastFailureCode, failures24h: r.failures24h, cancelsPending: r.cancelsPending, cancelsFailed: r.cancelsFailed }))).toEqual(ref);
    // 같은 시각 실패는 id가 큰 쪽의 코드
    const tied = failed.filter((x) => x.updatedAt.getTime() === tie.getTime() && x.sellerId === shops[0].id).sort((a, b) => (a.id < b.id ? 1 : -1));
    expect(body.sellers.find((r: Row) => r.seller.id === shops[0].id).lastFailureCode).toBe(tied[0].failureCode);
    // 게이트웨이 요약(전체 마지막 성공·마지막 실패와 그 코드)
    const okAll = pays.map((x) => x.approvedAt).filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0];
    expect(body.gateway).toMatchObject({ lastSuccessAt: okAll.toISOString(), lastFailureAt: failed[0].updatedAt.toISOString(), lastFailureCode: failed[0].failureCode });
    // 쪽 이동은 같은 순서로 이어진다
    const p1 = await (await get(pgStatusRoute, "/api/admin/pg-status?limit=3", await adminCookie())).json();
    const p2 = await (await get(pgStatusRoute, `/api/admin/pg-status?limit=3&cursor=${p1.nextCursor}`, await adminCookie())).json();
    expect([...p1.sellers, ...p2.sellers].map((r: Row) => r.seller.id)).toEqual(ref.map((r) => r.id));
    expect(p2.nextCursor).toBeNull();
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

describe("PG 연결 상태 확장(MA-031 정본 v295): 24시간 요약·상태 필터·기간·LIVE", () => {
  type Row = { seller: { id: string; shopName: string }; live: boolean; failures24h: number; failuresInPeriod: number; cancelsPending: number; cancelsFailed: number };
  const ids = (b: { sellers: Row[] }) => b.sellers.map((s) => s.seller.id);

  async function fixture() {
    setPaymentGatewayForTest(new FakePaymentGateway());
    const now = Date.now();
    // A: 24시간 안 실패 1건·성공 1건(2시간 전, 최근 성공)·취소 대기 1건, 방송 중
    const a = await shopWithPayments("가게A", [{ status: "PAID", at: new Date(now - 2 * HOUR) }, { status: "FAILED", at: new Date(now - 3 * HOUR), code: "nicepay_3095" }], ["REQUESTED"]);
    await db.broadcastSession.create({ data: { sellerId: a.id, status: "LIVE" } });
    // B: 3일 전 실패만(7일 안, 24시간 밖), 취소 실패 1건, 방송 종료
    const b = await shopWithPayments("가게B", [{ status: "FAILED", at: new Date(now - 3 * 24 * HOUR), code: "amount_mismatch" }], ["FAILED"]);
    await db.broadcastSession.create({ data: { sellerId: b.id, status: "ENDED", endedAt: new Date() } });
    // C: 20일 전 실패(30일 안, 7일 밖)
    const c = await shopWithPayments("가게C", [{ status: "FAILED", at: new Date(now - 20 * 24 * HOUR), code: "nicepay_3021" }]);
    // D: 성공만(48시간 전, 24시간 요약에는 안 들어감)
    const d = await shopWithPayments("가게D", [{ status: "PAID", at: new Date(now - 48 * HOUR) }]);
    // E: 24시간 안 실패 1건, 다른 파트너스(실패한 파트너스 수 2)
    const e = await shopWithPayments("가게E", [{ status: "FAILED", at: new Date(now - 30 * 60_000), code: "approve_timeout" }]);
    return { a, b, c, d, e };
  }

  it("gateway.summary24h: 직전 24시간 성공·실패·실패한 파트너스 수와 마지막 성공·실패(쇼핑몰·금액·코드), 취소는 처리 안 끝난 건 전체", async () => {
    const f = await fixture();
    const body = await (await get(pgStatusRoute, "/api/admin/pg-status", await adminCookie())).json();
    expect(body.gateway.summary24h).toMatchObject({
      successCount: 1, // A의 2시간 전 성공(D는 48시간 전)
      failureCount: 2, // A 3시간 전, E 30분 전
      failedSellerCount: 2,
      cancelsPending: 1,
      cancelsFailed: 1, // B의 3일 전 취소 실패도 센다(처리 안 끝난 건)
      lastSuccess: { at: expect.any(String), sellerName: "가게A", amount: 10000 },
      lastFailure: { at: expect.any(String), sellerName: "가게E", code: "approve_timeout", message: paymentFailureMessage("approve_timeout") },
    });
    // 기간(7일·30일)을 바꿔도 요약은 24시간 기준 그대로
    for (const period of ["7d", "30d"]) {
      const b = await (await get(pgStatusRoute, `/api/admin/pg-status?period=${period}`, await adminCookie())).json();
      expect(b.gateway.summary24h).toEqual(body.gateway.summary24h);
    }
    expect(f.a.id).toBeTruthy();
  });

  it("결제가 하나도 없으면 요약은 0과 null이다", async () => {
    setPaymentGatewayForTest(new FakePaymentGateway());
    const body = await (await get(pgStatusRoute, "/api/admin/pg-status", await adminCookie())).json();
    expect(body.gateway.summary24h).toEqual({ successCount: 0, failureCount: 0, failedSellerCount: 0, cancelsPending: 0, cancelsFailed: 0, lastSuccess: null, lastFailure: null });
    expect(body.counts).toEqual({ all: 0, failed: 0, cancel: 0 });
  });

  it("상태 필터: failed는 기간 안 실패가 있는 파트너스, cancel은 처리 안 끝난 취소가 있는 파트너스, counts는 같은 기간 기준(status·쪽과 무관)", async () => {
    const f = await fixture();
    const cookie = await adminCookie();
    const all = await (await get(pgStatusRoute, "/api/admin/pg-status", cookie)).json();
    expect(all.counts).toEqual({ all: 5, failed: 2, cancel: 2 }); // 24시간: 실패 A·E, 취소 A·B
    expect(ids(all)).toHaveLength(5);
    const failed = await (await get(pgStatusRoute, "/api/admin/pg-status?status=failed", cookie)).json();
    expect(new Set(ids(failed))).toEqual(new Set([f.a.id, f.e.id]));
    expect(failed.counts).toEqual(all.counts);
    const cancel = await (await get(pgStatusRoute, "/api/admin/pg-status?status=cancel", cookie)).json();
    expect(new Set(ids(cancel))).toEqual(new Set([f.a.id, f.b.id]));
    // 7일: B(3일 전 실패)가 실패에 들어오고, 30일: C도 들어온다
    const f7 = await (await get(pgStatusRoute, "/api/admin/pg-status?status=failed&period=7d", cookie)).json();
    expect(new Set(ids(f7))).toEqual(new Set([f.a.id, f.b.id, f.e.id]));
    expect(f7.counts).toEqual({ all: 5, failed: 3, cancel: 2 });
    const f30 = await (await get(pgStatusRoute, "/api/admin/pg-status?status=failed&period=30d", cookie)).json();
    expect(new Set(ids(f30))).toEqual(new Set([f.a.id, f.b.id, f.c.id, f.e.id]));
    expect(f30.counts.failed).toBe(4);
    // 기간 안 실패 수(failuresInPeriod)와 24시간 실패 수(failures24h)
    const b30 = (f30.sellers as Row[]).find((s) => s.seller.id === f.b.id)!;
    expect(b30).toMatchObject({ failures24h: 0, failuresInPeriod: 1 });
    // 검색과 필터 조합, 쪽 나누기는 필터 뒤 목록 기준
    const q = await (await get(pgStatusRoute, `/api/admin/pg-status?status=failed&q=${encodeURIComponent("게E")}`, cookie)).json();
    expect(ids(q)).toEqual([f.e.id]);
    expect(q.counts).toEqual({ all: 1, failed: 1, cancel: 0 });
    const p1 = await (await get(pgStatusRoute, "/api/admin/pg-status?status=failed&limit=1", cookie)).json();
    expect(p1.sellers).toHaveLength(1);
    expect(p1.nextCursor).toBe("1");
    expect(p1.counts).toEqual(all.counts);
    const p2 = await (await get(pgStatusRoute, `/api/admin/pg-status?status=failed&limit=1&cursor=${p1.nextCursor}`, cookie)).json();
    expect(p2.sellers).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect(new Set([...ids(p1), ...ids(p2)])).toEqual(new Set([f.a.id, f.e.id]));
  });

  it("방송 중 파트너스는 live가 true, 방송이 끝났거나 없으면 false", async () => {
    const f = await fixture();
    const body = await (await get(pgStatusRoute, "/api/admin/pg-status", await adminCookie())).json();
    const live = Object.fromEntries((body.sellers as Row[]).map((s) => [s.seller.id, s.live]));
    expect(live).toEqual({ [f.a.id]: true, [f.b.id]: false, [f.c.id]: false, [f.d.id]: false, [f.e.id]: false });
  });

  it("status·period 값이 틀리면 400", async () => {
    setPaymentGatewayForTest(new FakePaymentGateway());
    for (const bad of ["?status=weird", "?period=1y", "?period=24H", "?status=constructor", "?period=toString"]) {
      expect((await get(pgStatusRoute, `/api/admin/pg-status${bad}`, await adminCookie())).status, bad).toBe(400);
    }
  });
});
