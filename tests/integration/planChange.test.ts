import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as planRoute } from "../../app/api/seller/subscription/plan/route";
import { loginSeller } from "../../lib/server/auth/login";
import { sellerFeatures } from "../../lib/server/billing/features";
import { changePlan } from "../../lib/server/billing/planChange";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { cancelSubscription, getSubscriptionView, reconcileStalePayments, registerCardAndPay, renewDueSubscriptions } from "../../lib/server/billing/subscription";
import { prisma } from "../../lib/server/db";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// ONQ 1-C-2 플랜 변경(ONQ_PLAN E1-B, ARCHITECTURE 4.8.0 결제 규칙). 실제 PG 없이 가짜 공급자로 확인한다.
beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
  process.env.BILLING_PROVIDER = "fake";
});
let plans: Awaited<ReturnType<typeof seedPlans>>;
beforeEach(async () => {
  await resetDb();
  plans = await seedPlans();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const ALL = ["OVERLAY", "EXTERNAL_INTEGRATION", "STORE_OPERATIONS"];
const OVERLAY = ["OVERLAY", "EXTERNAL_INTEGRATION"];
const T0 = new Date("2026-11-01T00:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

const declining = () =>
  new (class extends FakeBillingProvider {
    async charge() {
      return { ok: false as const, reason: "card_declined" };
    }
  })();

type PlanKey = "OVERLAY_ONLY" | "INTEGRATED";
// 판매자(플랜)와 구독 상태. sub가 없으면 구독 행 없음.
async function shop(plan: PlanKey, trialEndsAt: Date | null, sub?: Record<string, unknown>) {
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt, planId: plans[plan].id } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const subscription = sub
    ? await db.sellerSubscription.create({
        data: { sellerId: seller.id, planId: plans[plan].id, billingKeyCipher: sealBillingKey("bk-" + seller.id, seller.id), cardLabel: "카드", subscribedAt: at(-40), ...sub },
      })
    : null;
  return { seller, owner, ctx, subscription };
}
// 결제한 30일 기간 중 20일이 지남(10일 남음)
const paying = { status: "ACTIVE", currentPeriodStart: at(-20), currentPeriodEnd: at(10), billingAnchorAt: at(-20), nextChargeAt: at(9) };
const payments = (sellerId: string) =>
  db.subscriptionPayment.findMany({ where: { sellerId }, orderBy: { createdAt: "asc" }, select: { amount: true, status: true, kind: true } });
const subOf = (sellerId: string) => db.sellerSubscription.findUniqueOrThrow({ where: { sellerId }, include: { plan: true, pendingPlan: true } });
const planOf = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId }, include: { plan: true } })).plan?.code;

describe("상위 변경(오버레이 전용 → 통합)", () => {
  it("결제한 기간 중: 차액 = (179,000 − 69,000) × 10/30 원 단위 절사를 바로 결제, 결제일 그대로, 확정 뒤 통합 권한, 다음 갱신은 179,000원", async () => {
    const s = await shop("OVERLAY_ONLY", at(-30), paying);
    // 이번 기간을 이미 결제했다(같은 기간 결제 하나 제한은 기간 결제에만, 차액 청구는 따로 들어간다)
    await db.subscriptionPayment.create({
      data: { sellerId: s.seller.id, subscriptionId: s.subscription!.id, amount: 69000, status: "PAID", paidAt: at(-20), periodStart: at(-20), periodEnd: at(10), createdAt: at(-20) },
    });
    expect(await sellerFeatures(db, s.seller.id)).toEqual(OVERLAY);
    const r = await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "INTEGRATED", now: T0 });
    expect(r).toMatchObject({ ok: true, applied: "now", charged: 36666, planCode: "INTEGRATED" });
    expect(await payments(s.seller.id)).toEqual([
      { amount: 69000, status: "PAID", kind: "PERIOD" },
      { amount: 36666, status: "PAID", kind: "PRORATION" },
    ]);
    const sub = await subOf(s.seller.id);
    expect(sub).toMatchObject({ status: "ACTIVE", currentPeriodStart: at(-20), currentPeriodEnd: at(10), nextChargeAt: at(9), billingAnchorAt: at(-20) });
    expect(sub.plan.code).toBe("INTEGRATED");
    expect(await planOf(s.seller.id)).toBe("INTEGRATED");
    expect(await sellerFeatures(db, s.seller.id)).toEqual(ALL);
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: at(9) });
    expect((await payments(s.seller.id)).map((p) => [p.amount, p.kind])).toEqual([[69000, "PERIOD"], [36666, "PRORATION"], [179000, "PERIOD"]]);
  });

  it("상위 변경 결제가 거절되면 지금 플랜·권한 그대로이고 유예·결제일도 바뀌지 않는다", async () => {
    const s = await shop("OVERLAY_ONLY", at(-30), paying);
    expect(await changePlan(db, declining(), s.ctx, { planCode: "INTEGRATED", now: T0 })).toEqual({ ok: false, reason: "payment_failed" });
    expect(await payments(s.seller.id)).toEqual([{ amount: 36666, status: "FAILED", kind: "PRORATION" }]);
    expect(await subOf(s.seller.id)).toMatchObject({ status: "ACTIVE", graceUntil: null, retryCount: 0, nextChargeAt: at(9), plan: { code: "OVERLAY_ONLY" } });
    expect(await planOf(s.seller.id)).toBe("OVERLAY_ONLY");
    expect(await sellerFeatures(db, s.seller.id)).toEqual(OVERLAY);
  });

  it("결제 결과를 모르면(시간 초과) 대기로 두고 지금 플랜 그대로, 대사로 확정된 뒤에만 통합으로 바뀐다. 대기 중 다른 변경은 409", async () => {
    const s = await shop("OVERLAY_ONLY", at(-30), paying);
    const provider = new FakeBillingProvider();
    provider.failNext = "timeout_after_charge";
    expect(await changePlan(db, provider, s.ctx, { planCode: "INTEGRATED", now: T0 })).toEqual({ ok: false, reason: "payment_pending" });
    expect(await planOf(s.seller.id)).toBe("OVERLAY_ONLY");
    expect(await sellerFeatures(db, s.seller.id)).toEqual(OVERLAY);
    expect(await changePlan(db, provider, s.ctx, { planCode: "INTEGRATED", now: T0 })).toEqual({ ok: false, reason: "payment_in_progress" });
    await db.subscriptionPayment.updateMany({ where: { sellerId: s.seller.id }, data: { createdAt: new Date(Date.now() - 3_600_000) } });
    await reconcileStalePayments(db, provider);
    expect(await payments(s.seller.id)).toEqual([{ amount: 36666, status: "PAID", kind: "PRORATION" }]);
    expect(await planOf(s.seller.id)).toBe("INTEGRATED");
    expect(await sellerFeatures(db, s.seller.id)).toEqual(ALL);
  });

  it("체험 중(카드 등록): 체험을 끝내고 179,000원을 바로 결제, 결제일을 그날로 새로 잡는다. 거절이면 체험·플랜 그대로", async () => {
    const card = { status: "ACTIVE", nextChargeAt: at(5) };
    const failed = await shop("OVERLAY_ONLY", at(5), card);
    expect(await changePlan(db, declining(), failed.ctx, { planCode: "INTEGRATED", now: T0 })).toEqual({ ok: false, reason: "payment_failed" });
    expect((await db.seller.findUniqueOrThrow({ where: { id: failed.seller.id } })).trialEndsAt).toEqual(at(5));
    expect(await subOf(failed.seller.id)).toMatchObject({ status: "ACTIVE", nextChargeAt: at(5), currentPeriodEnd: null, plan: { code: "OVERLAY_ONLY" } });

    const s = await shop("OVERLAY_ONLY", at(5), card);
    expect(await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "INTEGRATED", now: T0 })).toMatchObject({ ok: true, applied: "now", charged: 179000 });
    expect((await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).trialEndsAt).toEqual(T0);
    const sub = await subOf(s.seller.id);
    expect(sub).toMatchObject({ status: "ACTIVE", currentPeriodStart: T0, billingAnchorAt: T0, plan: { code: "INTEGRATED" } });
    expect(sub.currentPeriodEnd!.getTime()).toBeGreaterThan(at(27).getTime());
    expect(sub.nextChargeAt!.getTime()).toBe(sub.currentPeriodEnd!.getTime() - DAY);
    expect(await sellerFeatures(db, s.seller.id)).toEqual(ALL);
  });

  it("체험 중인데 카드가 없으면 card_required이고 결제·플랜 변경 0건(결제 없이 통합을 열지 않음)", async () => {
    const s = await shop("OVERLAY_ONLY", at(5));
    expect(await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "INTEGRATED", now: T0 })).toEqual({ ok: false, reason: "card_required" });
    expect(await planOf(s.seller.id)).toBe("OVERLAY_ONLY");
    expect(await db.subscriptionPayment.count()).toBe(0);
    expect(await sellerFeatures(db, s.seller.id)).toEqual(OVERLAY);
  });

  it("결제 실패 유예 중(PAST_DUE): 밀린 69,000원과 남은 기간 차액을 한 번에 결제해 확정되면 ACTIVE·통합. 거절이면 유예 그대로", async () => {
    // 지난 기간(9/30~10/30, 기준일 9/30)이 이틀 전에 끝났고 유예 중. 밀린 기간 = 10/30~11/30(KST 기준일)
    const start = new Date("2026-09-30T00:00:00Z");
    const pastDue = { status: "PAST_DUE", currentPeriodStart: start, currentPeriodEnd: at(-2), billingAnchorAt: start, nextChargeAt: at(1), graceUntil: at(6), retryCount: 1 };
    const f = await shop("OVERLAY_ONLY", at(-60), pastDue);
    expect(await changePlan(db, declining(), f.ctx, { planCode: "INTEGRATED", now: T0 })).toEqual({ ok: false, reason: "payment_failed" });
    expect(await subOf(f.seller.id)).toMatchObject({ status: "PAST_DUE", graceUntil: at(6), retryCount: 1, nextChargeAt: at(1), plan: { code: "OVERLAY_ONLY" } });

    const s = await shop("OVERLAY_ONLY", at(-60), pastDue);
    const r = await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "INTEGRATED", now: T0 });
    expect(r).toMatchObject({ ok: true, applied: "now" });
    const [p] = await payments(s.seller.id);
    // 밀린 기간 10/30 ~ 11/30, 그중 지금(11/1)부터 끝까지의 비율(29/31)만큼 차액
    const periodEnd = (await subOf(s.seller.id)).currentPeriodEnd!;
    expect(periodEnd).toEqual(new Date("2026-11-30T00:00:00Z"));
    const ratio = (periodEnd.getTime() - T0.getTime()) / (periodEnd.getTime() - at(-2).getTime());
    expect(p).toMatchObject({ kind: "PERIOD", status: "PAID", amount: 69000 + Math.floor(110000 * ratio) });
    expect(await subOf(s.seller.id)).toMatchObject({ status: "ACTIVE", graceUntil: null, retryCount: 0, currentPeriodStart: at(-2), plan: { code: "INTEGRATED" } });
    expect(await sellerFeatures(db, s.seller.id)).toEqual(ALL);
  });

  it("결제한 기간·체험이 없으면(잠김) 결제 없이 플랜만 바꾸고, 카드 등록 때 통합 금액으로 결제한다", async () => {
    const s = await shop("OVERLAY_ONLY", at(-30));
    expect(await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "INTEGRATED", now: T0 })).toMatchObject({ ok: true, applied: "now", charged: 0 });
    expect(await planOf(s.seller.id)).toBe("INTEGRATED");
    expect(await db.subscriptionPayment.count()).toBe(0);
  });
});

describe("하위 변경(통합 → 오버레이 전용)", () => {
  it("결제한 기간 중이면 다음 결제일부터: 그때까지 통합 권한·금액 그대로, 갱신 결제가 69,000원이고 그 뒤 오버레이 권한(환불 없음)", async () => {
    const s = await shop("INTEGRATED", at(-30), { ...paying, legacyPrice: 199000 });
    const r = await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "OVERLAY_ONLY", now: T0 });
    expect(r).toMatchObject({ ok: true, applied: "next_payment", charged: 0, effectiveAt: at(9) });
    expect(await db.subscriptionPayment.count()).toBe(0);
    expect(await subOf(s.seller.id)).toMatchObject({ plan: { code: "INTEGRATED" }, pendingPlan: { code: "OVERLAY_ONLY" } });
    expect(await sellerFeatures(db, s.seller.id)).toEqual(ALL);
    const view = await getSubscriptionView(db, s.ctx, T0);
    expect(view.subscription).toMatchObject({ pendingPlanCode: "OVERLAY_ONLY" });
    expect(view.plan).toMatchObject({ code: "INTEGRATED", nextAmount: 69000 });

    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: at(9) });
    // 이전 전 가격 스냅숏(199,000원)은 플랜이 바뀌면 끝난다
    expect(await payments(s.seller.id)).toEqual([{ amount: 69000, status: "PAID", kind: "PERIOD" }]);
    expect(await subOf(s.seller.id)).toMatchObject({ plan: { code: "OVERLAY_ONLY" }, pendingPlanId: null, legacyPrice: null });
    expect(await planOf(s.seller.id)).toBe("OVERLAY_ONLY");
    // 변경 전에 받은 주문 처리(ORDER_FOLLOWUP)는 기능 권한이 남아 있어 열린다
    expect(await sellerFeatures(db, s.seller.id)).toEqual(OVERLAY);
  });

  it("예약한 하위 변경은 지금 플랜을 다시 고르면 거둔다(갱신은 179,000원)", async () => {
    const s = await shop("INTEGRATED", at(-30), paying);
    await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "OVERLAY_ONLY", now: T0 });
    expect(await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "INTEGRATED", now: T0 })).toMatchObject({ ok: true, applied: "canceled_pending" });
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: at(9) });
    expect(await payments(s.seller.id)).toEqual([{ amount: 179000, status: "PAID", kind: "PERIOD" }]);
  });

  it("해지 예약 구독은 기간 끝에 하위 변경 없이 해지(갱신 결제 0건)", async () => {
    const s = await shop("INTEGRATED", at(-30), { ...paying, cancelAtPeriodEnd: true, nextChargeAt: at(10) });
    await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "OVERLAY_ONLY", now: T0 });
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: at(10) });
    expect(await db.subscriptionPayment.count()).toBe(0);
    expect((await subOf(s.seller.id)).status).toBe("CANCELED");
  });

  it("결제한 기간이 없으면(첫 결제 전 통합) 바로 바뀐다", async () => {
    const s = await shop("INTEGRATED", null);
    expect(await sellerFeatures(db, s.seller.id)).toEqual([]);
    expect(await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "OVERLAY_ONLY", now: T0 })).toMatchObject({ ok: true, applied: "now" });
    expect(await planOf(s.seller.id)).toBe("OVERLAY_ONLY");
  });
});

describe("입력·권한", () => {
  it("같은 플랜 409, STANDARD·모르는 값 400, 직원은 403(대표자 전용), HTTP 경로", async () => {
    const s = await shop("OVERLAY_ONLY", at(-30), paying);
    expect(await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "OVERLAY_ONLY", now: T0 })).toEqual({ ok: false, reason: "same_plan" });
    for (const planCode of ["STANDARD", "PRO", 3]) expect(await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode })).toEqual({ ok: false, reason: "invalid_plan" });
    const staff = await createSellerUser(s.seller.id, "MANAGER");
    await expect(changePlan(db, new FakeBillingProvider(), { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] }, { planCode: "INTEGRATED" })).rejects.toMatchObject({ status: 403 });
    expect(await db.subscriptionPayment.count()).toBe(0);

    const login = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const post = (body: unknown) =>
      planRoute(
        new Request("http://localhost:3000/api/seller/subscription/plan", {
          method: "POST",
          headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", cookie: `lo_seller=${login.token}` },
          body: JSON.stringify(body),
        }),
      );
    expect((await post({ planCode: "STANDARD" })).status).toBe(400);
    expect((await post({ planCode: "OVERLAY_ONLY" })).status).toBe(409);
  });
});

describe("런칭 할인 계정당 1회(대표님 결정 2026-10-04)", () => {
  const used = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).launchDiscountUsedAt;
  // 해지하고 기간 끝까지 쓴 뒤(예약 실행이 CANCELED로) 다시 카드 등록
  async function cancelAndRestart(s: { ctx: TenantContext; seller: { id: string } }, endsAt: Date, restartAt: Date) {
    await cancelSubscription(db, s.ctx, { now: new Date(endsAt.getTime() - DAY) });
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: endsAt });
    expect((await subOf(s.seller.id)).status).toBe("CANCELED");
    return registerCardAndPay(db, new FakeBillingProvider(), s.ctx, { authKey: "auth", now: restartAt });
  }

  it("런칭가 첫 결제가 확정되면 사용을 남기고, 구독이 이어지는 동안 갱신은 런칭가, 해지 뒤 재구독은 정가 249,000원(갱신도 정가)", async () => {
    const s = await shop("INTEGRATED", null);
    expect(await registerCardAndPay(db, new FakeBillingProvider(), s.ctx, { authKey: "auth", now: T0 })).toMatchObject({ ok: true, charged: true });
    expect(await used(s.seller.id)).toEqual(T0);
    const first = await subOf(s.seller.id);
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: first.nextChargeAt! });
    expect((await payments(s.seller.id)).map((p) => p.amount)).toEqual([179000, 179000]);

    const sub = await subOf(s.seller.id);
    expect(await cancelAndRestart(s, sub.currentPeriodEnd!, new Date(sub.currentPeriodEnd!.getTime() + 5 * DAY))).toMatchObject({ ok: true, charged: true });
    expect((await payments(s.seller.id)).map((p) => p.amount)).toEqual([179000, 179000, 249000]);
    const restarted = await subOf(s.seller.id);
    expect(restarted.regularPrice).toBe(true);
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: restarted.nextChargeAt! });
    expect((await payments(s.seller.id)).map((p) => p.amount)).toEqual([179000, 179000, 249000, 249000]);
    expect((await getSubscriptionView(db, s.ctx, restarted.nextChargeAt!)).plan).toMatchObject({ nextAmount: 249000 });
  });

  it("오버레이 전용 런칭가(69,000원)로 쓰던 계정의 구독 중 상위 변경은 런칭가 기준 차액, 다음 갱신은 통합 런칭가 179,000원", async () => {
    const s = await shop("OVERLAY_ONLY", at(-30), paying);
    await db.seller.update({ where: { id: s.seller.id }, data: { launchDiscountUsedAt: at(-20) } });
    expect(await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "INTEGRATED", now: T0 })).toMatchObject({ ok: true, charged: 36666 });
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: at(9) });
    expect((await payments(s.seller.id)).map((p) => p.amount)).toEqual([36666, 179000]);
  });

  it("정가 구독(해지 뒤 재구독)의 상위 변경은 정가 기준 차액 (249,000 − 99,000) × 10/30, 다음 갱신은 정가 249,000원", async () => {
    const s = await shop("OVERLAY_ONLY", at(-30), { ...paying, regularPrice: true });
    await db.seller.update({ where: { id: s.seller.id }, data: { launchDiscountUsedAt: at(-200) } });
    expect(await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "INTEGRATED", now: T0 })).toMatchObject({ ok: true, charged: 50000 });
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: at(9) });
    expect((await payments(s.seller.id)).map((p) => p.amount)).toEqual([50000, 249000]);
  });

  it("이전된 STANDARD 이력은 사용으로 세지 않는다: 첫 재구독 한 번은 통합 런칭가 179,000원, 그 뒤 해지·재구독은 정가", async () => {
    const s = await shop("INTEGRATED", at(-60), { ...paying, legacyPrice: 199000 });
    // 이전 전 STANDARD로 낸 결제(런칭가 아님)
    await db.subscriptionPayment.create({
      data: { sellerId: s.seller.id, subscriptionId: s.subscription!.id, amount: 199000, status: "PAID", paidAt: at(-20), periodStart: at(-20), periodEnd: at(10), createdAt: at(-20) },
    });
    // 이전 전 가격 갱신(고지 미발송, 스냅숏 199,000원)도 런칭 할인 사용이 아니다
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: at(9) });
    expect(await used(s.seller.id)).toBeNull();
    const sub = await subOf(s.seller.id);
    expect(await cancelAndRestart(s, sub.currentPeriodEnd!, new Date(sub.currentPeriodEnd!.getTime() + 3 * DAY))).toMatchObject({ ok: true });
    expect((await payments(s.seller.id)).map((p) => p.amount)).toEqual([199000, 199000, 179000]);
    expect(await used(s.seller.id)).not.toBeNull();
    const again = await subOf(s.seller.id);
    expect(await cancelAndRestart(s, again.currentPeriodEnd!, new Date(again.currentPeriodEnd!.getTime() + 3 * DAY))).toMatchObject({ ok: true });
    expect((await payments(s.seller.id)).map((p) => p.amount)).toEqual([199000, 199000, 179000, 249000]);
  });

  it("거절된 런칭가 결제는 사용으로 세지 않는다(다시 결제하면 런칭가)", async () => {
    const s = await shop("INTEGRATED", null);
    const declined = await registerCardAndPay(db, declining(), s.ctx, { authKey: "auth", now: T0 });
    expect(declined).toMatchObject({ ok: false, reason: "payment_failed" });
    expect(await used(s.seller.id)).toBeNull();
    expect(await registerCardAndPay(db, new FakeBillingProvider(), s.ctx, { authKey: "auth", now: T0 })).toMatchObject({ ok: true });
    expect((await payments(s.seller.id)).map((p) => [p.amount, p.status])).toEqual([[179000, "FAILED"], [179000, "PAID"]]);
  });
});
