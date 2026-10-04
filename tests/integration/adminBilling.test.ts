import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as paymentRoute } from "../../app/api/admin/payments/[paymentId]/route";
import { GET as paymentsRoute } from "../../app/api/admin/payments/route";
import { GET as subsRoute } from "../../app/api/admin/subscriptions/route";
import { listAdminSubscriptions } from "../../lib/server/admin/billing";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { sellerAccess } from "../../lib/server/billing/access";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 마스터 관리자 구독 현황(MA-023)·청구·결제 내역(MA-024·025). 조회만 한다.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000" };
const DAY = 86_400_000;
const NOW = new Date("2026-11-01T00:00:00Z");
const at = (d: number) => new Date(NOW.getTime() + d * DAY);
async function admin(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "READ_ONLY") {
  const a = await createAdmin(role);
  const s = await createAdminSession(db, a.id, {});
  return { cookie: `lo_admin=${s.token}`, ctx: (await resolveAdminSession(db, s.token))! };
}
const get = (route: (r: Request) => Promise<Response>, path: string, cookie: string) => route(new Request(`http://localhost:3000${path}`, { headers: { ...H, cookie } }));

describe("구독 현황 GET /api/admin/subscriptions", () => {
  it("이용 상태는 파트너스 판정(sellerAccess)과 같다: 체험·결제한 기간·결제 처리 대기·유예(연체)·만료·해지·구독 없음", async () => {
    const plans = await seedPlans();
    const { ctx } = await admin();
    const cases: Record<string, { trialEndsAt: Date | null; sub?: Record<string, unknown> }> = {
      trial: { trialEndsAt: at(3) },
      trialWithCard: { trialEndsAt: at(3), sub: { status: "ACTIVE", nextChargeAt: at(3) } },
      paid: { trialEndsAt: at(-30), sub: { status: "ACTIVE", currentPeriodStart: at(-10), currentPeriodEnd: at(20), nextChargeAt: at(19) } },
      // 결제한 기간이 체험보다 먼저(체험 끝 전이어도 결제했으면 이용 중)
      paidDuringTrial: { trialEndsAt: at(3), sub: { status: "ACTIVE", currentPeriodStart: at(-1), currentPeriodEnd: at(29), nextChargeAt: at(28) } },
      // 유예가 남았어도 해지 예약이면 만료
      graceCancel: { trialEndsAt: null, sub: { status: "PAST_DUE", currentPeriodEnd: at(-2), graceUntil: at(5), cancelAtPeriodEnd: true } },
      cancelScheduled: { trialEndsAt: null, sub: { status: "ACTIVE", currentPeriodStart: at(-10), currentPeriodEnd: at(20), cancelAtPeriodEnd: true } },
      charging: { trialEndsAt: at(-30), sub: { status: "ACTIVE", currentPeriodEnd: at(-1), nextChargeAt: at(-1) } },
      grace: { trialEndsAt: null, sub: { status: "PAST_DUE", currentPeriodEnd: at(-2), graceUntil: at(5), retryCount: 1 } },
      graceOver: { trialEndsAt: null, sub: { status: "PAST_DUE", currentPeriodEnd: at(-9), graceUntil: at(-2) } },
      canceled: { trialEndsAt: null, sub: { status: "CANCELED", currentPeriodEnd: at(-5), canceledAt: at(-5) } },
      noSub: { trialEndsAt: at(-1) },
    };
    const ids: Record<string, string> = {};
    for (const [name, c] of Object.entries(cases)) {
      const { seller } = await createSeller();
      await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: c.trialEndsAt, approvedAt: at(-40), planId: plans.INTEGRATED.id } });
      if (c.sub) await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plans.INTEGRATED.id, subscribedAt: at(-40), ...c.sub } });
      ids[name] = seller.id;
    }
    // 승인 전 신청은 빠진다
    const pending = (await createSeller()).seller;
    await db.seller.update({ where: { id: pending.id }, data: { status: "PENDING", approvedAt: null } });

    const r = await listAdminSubscriptions(db, ctx, {}, { now: NOW });
    if (!r.ok) throw new Error("bad");
    expect(r.subscriptions.map((s) => s.seller.id)).not.toContain(pending.id);
    for (const [name, id] of Object.entries(ids)) {
      const s = await db.seller.findUniqueOrThrow({ where: { id }, include: { subscription: true } });
      const row = r.subscriptions.find((x) => x.seller.id === id)!;
      expect([name, row.access]).toEqual([name, sellerAccess({ trialEndsAt: s.trialEndsAt, subscription: s.subscription }, NOW)]);
    }
    expect(r.counts).toEqual({ trial: 2, paid: 3, charging: 1, grace: 1, expired: 4 });
    const graceOnly = await listAdminSubscriptions(db, ctx, { access: "grace" }, { now: NOW });
    expect(graceOnly.ok && graceOnly.subscriptions.map((s) => [s.seller.id, s.subscription?.retryCount])).toEqual([[ids.grace, 1]]);
    // 필터와 상관없이 counts는 전체 기준
    expect(graceOnly.ok && graceOnly.counts).toEqual(r.counts);
  });

  it("요금제·이름 검색·커서(같은 가입 시각 포함)로 끝까지 빠짐·겹침 없음, 잘못된 값 400, 조회 전용도 열람, 파트너스 세션은 401", async () => {
    const plans = await seedPlans();
    const { cookie } = await admin("READ_ONLY");
    const made: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { seller } = await createSeller();
      await db.seller.update({ where: { id: seller.id }, data: { approvedAt: new Date(), createdAt: new Date("2026-10-01T00:00:00Z"), planId: i === 0 ? plans.OVERLAY_ONLY.id : plans.INTEGRATED.id } });
      made.push(seller.id);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res = await get(subsRoute, `/api/admin/subscriptions?limit=2${cursor ? `&cursor=${cursor}` : ""}`, cookie);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { subscriptions: { seller: { id: string } }[]; nextCursor: string | null };
      seen.push(...body.subscriptions.map((s) => s.seller.id));
      cursor = body.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual([...made].sort());
    const overlay = (await (await get(subsRoute, "/api/admin/subscriptions?plan=OVERLAY_ONLY", cookie)).json()) as { subscriptions: { seller: { id: string } }[] };
    expect(overlay.subscriptions.map((s) => s.seller.id)).toEqual([made[0]]);
    for (const qs of ["access=nope", "plan=PRO", "limit=0", "cursor=bad"]) expect((await get(subsRoute, `/api/admin/subscriptions?${qs}`, cookie)).status).toBe(400);

    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    expect((await get(subsRoute, "/api/admin/subscriptions", `lo_seller=${login.token}`)).status).toBe(401);
    expect((await get(paymentsRoute, "/api/admin/payments", `lo_seller=${login.token}`)).status).toBe(401);
  });
});

describe("청구·결제 내역 GET /api/admin/payments·/{id}", () => {
  it("청구 시각 내림차순, 상태·종류·파트너스·KST 날짜 필터(끝 날짜 포함), 커서, 상세(결제 번호·매출전표), 없는 id 404, 아무것도 바꾸지 않음", async () => {
    const plans = await seedPlans();
    const { cookie } = await admin("CS");
    const a = (await createSeller()).seller;
    const b = (await createSeller()).seller;
    const subA = await db.sellerSubscription.create({ data: { sellerId: a.id, planId: plans.INTEGRATED.id, cardLabel: "카드A" } });
    const subB = await db.sellerSubscription.create({ data: { sellerId: b.id, planId: plans.OVERLAY_ONLY.id } });
    const pay = (sellerId: string, subscriptionId: string, createdAt: Date, extra: Record<string, unknown> = {}) =>
      db.subscriptionPayment.create({ data: { sellerId, subscriptionId, amount: 179000, periodStart: createdAt, periodEnd: new Date(createdAt.getTime() + 30 * DAY), createdAt, ...extra } });
    // KST 10/5 0시 정각, 10/5 23:59:59.999, 10/6 0시
    const p1 = await pay(a.id, subA.id, new Date("2026-10-04T15:00:00.000Z"), { status: "PAID", paidAt: new Date("2026-10-04T15:00:01Z"), providerPaymentId: "pg-1", receiptUrl: "https://pg.example/r/1" });
    const p2 = await pay(a.id, subA.id, new Date("2026-10-05T14:59:59.999Z"), { status: "FAILED", failureReason: "card_declined", kind: "PRORATION", amount: 36666, targetPlanId: plans.INTEGRATED.id });
    const p3 = await pay(b.id, subB.id, new Date("2026-10-05T15:00:00.000Z"), { status: "PENDING", amount: 69000 });
    const list = async (qs: string) => {
      const res = await get(paymentsRoute, `/api/admin/payments${qs}`, cookie);
      expect(res.status).toBe(200);
      return ((await res.json()) as { payments: { id: string }[]; nextCursor: string | null }).payments.map((p) => p.id);
    };
    expect(await list("")).toEqual([p3.id, p2.id, p1.id]);
    expect(await list("?status=FAILED")).toEqual([p2.id]);
    expect(await list("?kind=PRORATION")).toEqual([p2.id]);
    expect(await list(`?sellerId=${b.id}`)).toEqual([p3.id]);
    expect(await list("?from=2026-10-05&to=2026-10-05")).toEqual([p2.id, p1.id]);
    expect(await list("?from=2026-10-06")).toEqual([p3.id]);
    const first = (await (await get(paymentsRoute, "/api/admin/payments?limit=2", cookie)).json()) as { payments: { id: string }[]; nextCursor: string };
    expect(first.payments.map((p) => p.id)).toEqual([p3.id, p2.id]);
    expect(await list(`?limit=2&cursor=${first.nextCursor}`)).toEqual([p1.id]);
    for (const qs of ["status=DONE", "kind=X", "sellerId=nope", "from=2026-02-30", "to=10/5", "limit=-1", "cursor=x"]) {
      expect((await get(paymentsRoute, `/api/admin/payments?${qs}`, cookie)).status).toBe(400);
    }
    const listed = ((await (await get(paymentsRoute, "/api/admin/payments?status=FAILED", cookie)).json()) as { payments: Record<string, unknown>[] }).payments[0];
    expect(listed).toMatchObject({ amount: 36666, kind: "PRORATION", failureReason: "card_declined", targetPlanCode: "INTEGRATED", seller: { id: a.id } });

    const detail = (id: string) =>
      paymentRoute(new Request(`http://localhost:3000/api/admin/payments/${id}`, { headers: { ...H, cookie } }), { params: Promise.resolve({ paymentId: id }) });
    const d = await detail(p1.id);
    expect(d.status).toBe(200);
    expect(((await d.json()) as { payment: unknown }).payment).toMatchObject({
      id: p1.id,
      status: "PAID",
      providerPaymentId: "pg-1",
      receiptUrl: "https://pg.example/r/1",
      subscription: { cardLabel: "카드A", plan: { code: "INTEGRATED" } },
    });
    expect((await detail("00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await detail("nope")).status).toBe(404);
    expect(await db.subscriptionPayment.count()).toBe(3);
    expect(await db.auditLog.count()).toBe(0);
  });
});
