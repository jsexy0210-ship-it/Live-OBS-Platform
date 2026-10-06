import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listBillingInvoices } from "../../lib/server/admin/billingInvoices";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { addMonthsKst } from "../../lib/server/billing/access";
import { changePlan, previewPlanChanges } from "../../lib/server/billing/planChange";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { getSubscriptionView, registerCardAndPay, renewDueSubscriptions, settlePayment } from "../../lib/server/billing/subscription";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createAdmin, createSeller, db, resetDb, seedPlans } from "./helpers";

beforeAll(() => { process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef"; });
beforeEach(resetDb);
afterAll(() => db.$disconnect());
const DAY = 86_400_000;
const FIRST = new Date("2026-01-31T23:45:12.123+09:00");
const END = new Date("2026-04-30T23:45:12.123+09:00");

async function shop(code: "OVERLAY_ONLY" | "INTEGRATED", usedAt: Date | null = FIRST) {
  const plans = await seedPlans();
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: null, planId: plans[code].id, launchDiscountUsedAt: usedAt } });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SYSTEM", actorId: seller.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, ctx, plan: plans[code] };
}
const used = async (id: string) => (await db.seller.findUniqueOrThrow({ where: { id } })).launchDiscountUsedAt;
const amounts = async (id: string) => (await db.subscriptionPayment.findMany({ where: { sellerId: id }, orderBy: { createdAt: "asc" } })).map(p => p.amount);

describe("ONQ 계정 3개월 런칭 할인 실제 청구(E1-B)", () => {
  it.each([
    ["OVERLAY_ONLY", 69000, 99000], ["INTEGRATED", 179000, 249000],
  ] as const)("%s: 만료 1ms 전 재가입은 잔여 할인, 만료 시각 갱신은 정가", async (code, sale, list) => {
    const s = await shop(code);
    // 과거 해지 후 정가 플래그도 새 할인 기간을 막지 않는다.
    await db.sellerSubscription.create({ data: { sellerId: s.seller.id, planId: s.plan.id, status: "CANCELED", regularPrice: true, canceledAt: FIRST } });
    const beforeEnd = new Date(END.getTime() - 1);
    expect(await registerCardAndPay(db, new FakeBillingProvider(), s.ctx, { authKey: "auth", now: beforeEnd })).toMatchObject({ ok: true, charged: true });
    expect(await amounts(s.seller.id)).toEqual([sale]);
    expect(await used(s.seller.id)).toEqual(FIRST);
    // 예약 실행이 늦어 과거 nextChargeAt이 남아도 현재 이후 정가를 보여 준다.
    await db.sellerSubscription.update({ where: { sellerId: s.seller.id }, data: { nextChargeAt: beforeEnd } });
    expect((await getSubscriptionView(db, s.ctx, END)).plan?.nextAmount).toBe(list);
    expect((await previewPlanChanges(db, s.ctx, { now: END })).plans.find(p => p.planCode === code)?.price).toBe(list);
    // 결제한 기간이 이어져도 만료 시각부터 정가(예약 실행의 실제 청구 시각).
    await db.sellerSubscription.update({ where: { sellerId: s.seller.id }, data: { nextChargeAt: END } });
    const view = await getSubscriptionView(db, s.ctx, beforeEnd);
    expect(view.plan).toMatchObject({ nextAmount: list, launchDiscount: { active: false, endsAt: END } });
    expect((await previewPlanChanges(db, s.ctx, { now: beforeEnd })).plans.find(p => p.planCode === code)?.price).toBe(list);
    expect(await renewDueSubscriptions(db, new FakeBillingProvider(), { now: END })).toMatchObject({ charged: 1, errors: 0 });
    expect(await amounts(s.seller.id)).toEqual([sale, list]);
    expect(await used(s.seller.id)).toEqual(FIRST);
  });

  it.each(["OVERLAY_ONLY", "INTEGRATED"] as const)("%s: 만료 시각과 이후에 직접 재가입하면 정가, 시작 시각 유지", async code => {
    const s = await shop(code);
    expect(await registerCardAndPay(db, new FakeBillingProvider(), s.ctx, { authKey: "auth", now: END })).toMatchObject({ ok: true });
    expect(await amounts(s.seller.id)).toEqual([s.plan.listPrice]);
    expect(await used(s.seller.id)).toEqual(FIRST);
  });

  it("미사용 계정은 오래된 가입·실패·PENDING에도 혜택 유지, 대사 성공 때 시작하고 중복 확정은 초기화하지 않는다", async () => {
    const s = await shop("INTEGRATED", null);
    const declined = new class extends FakeBillingProvider { async charge() { return { ok: false as const, reason: "declined" }; } }();
    expect(await registerCardAndPay(db, declined, s.ctx, { authKey: "auth", now: FIRST })).toMatchObject({ ok: false });
    expect(await used(s.seller.id)).toBeNull();
    const later = new Date("2027-11-30T00:05:00+09:00");
    const pending = new class extends FakeBillingProvider { async charge(): Promise<never> { throw new Error("timeout"); } }();
    expect(await registerCardAndPay(db, pending, s.ctx, { authKey: "auth", now: later })).toMatchObject({ reason: "payment_pending" });
    expect(await used(s.seller.id)).toBeNull();
    const payment = await db.subscriptionPayment.findFirstOrThrow({ where: { sellerId: s.seller.id, status: "PENDING" } });
    const paidAt = new Date(later.getTime() + DAY);
    await settlePayment(db, payment.id, { ok: true, paymentId: "fake-paid", receiptUrl: null }, { actorType: "SYSTEM", actorId: null, now: paidAt });
    await settlePayment(db, payment.id, { ok: true, paymentId: "fake-paid", receiptUrl: null }, { actorType: "SYSTEM", actorId: null, now: new Date(paidAt.getTime() + DAY) });
    expect(await used(s.seller.id)).toEqual(paidAt);
    expect(await amounts(s.seller.id)).toEqual([179000, 179000]);
    expect((await getSubscriptionView(db, s.ctx, paidAt)).plan?.launchDiscount.endsAt).toEqual(addMonthsKst(paidAt, 3));
  });

  it("만료 뒤 상위 변경 차액·미리보기는 정가 차액이며 할인 시작을 갱신하지 않는다", async () => {
    const s = await shop("OVERLAY_ONLY");
    const start = new Date(END.getTime() - 20 * DAY), end = new Date(END.getTime() + 10 * DAY);
    await db.sellerSubscription.create({ data: { sellerId: s.seller.id, planId: s.plan.id, status: "ACTIVE", subscribedAt: FIRST, currentPeriodStart: start, currentPeriodEnd: end, nextChargeAt: new Date(end.getTime() - DAY), billingAnchorAt: start, billingKeyCipher: sealBillingKey("bk", s.seller.id) } });
    const preview = await previewPlanChanges(db, s.ctx, { now: END });
    expect(preview.plans.find(p => p.planCode === "INTEGRATED")).toMatchObject({ price: 249000, change: { ok: true, chargeNow: 50000 } });
    expect(await changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "INTEGRATED", expectedAmount: 50000, now: END })).toMatchObject({ ok: true, charged: 50000 });
    expect(await used(s.seller.id)).toEqual(FIRST);
    expect(await amounts(s.seller.id)).toEqual([50000]);
  });

  it("마스터 예정 금액·요약·판매자 화면은 만료 뒤 정가이며 하위 변경 예약도 같은 금액", async () => {
    const now = new Date();
    const s = await shop("INTEGRATED", new Date(now.getTime() - 200 * DAY));
    const plans = await seedPlans();
    await db.sellerSubscription.create({ data: { sellerId: s.seller.id, planId: s.plan.id, pendingPlanId: plans.OVERLAY_ONLY.id, subscribedAt: new Date(now.getTime() - 100 * DAY), currentPeriodEnd: new Date(now.getTime() + 5 * DAY), nextChargeAt: new Date(now.getTime() + 4 * DAY), billingKeyCipher: sealBillingKey("bk", s.seller.id) } });
    const a = await createAdmin("SUPER_ADMIN");
    const token = (await createAdminSession(db, a.id, {})).token;
    const admin = (await resolveAdminSession(db, token))!;
    const kst = (d: Date) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    const invoices = await listBillingInvoices(db, admin, { from: kst(now), to: kst(new Date(now.getTime() + 10 * DAY)) });
    expect(invoices).toMatchObject({ ok: true, summary: { scheduled: { count: 1, estimatedAmount: 99000 } }, items: [{ state: "SCHEDULED", amount: 99000, planCode: "OVERLAY_ONLY", launchDiscount: false }] });
    expect((await getSubscriptionView(db, s.ctx, now)).plan?.nextAmount).toBe(99000);
  });
  it("마스터 예정 SQL도 KST 만료 1ms 경계와 별도 30일 가격 고지를 같은 기준으로 계산한다", async () => {
    const now = new Date();
    const kstNow = new Date(now.getTime() + 9 * 3600000);
    const next = new Date(Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth() + 1, 15, 0, 5) - 9 * 3600000);
    const first = addMonthsKst(next, -3);
    const discounted = await shop("OVERLAY_ONLY", new Date(first.getTime() + 1));
    const expired = await shop("OVERLAY_ONLY", new Date(first.getTime() - 1));
    // 표시 가격이 방금 바뀌어도 고지 30일 전에는 과거 가격을 유지한다.
    await db.subscriptionPriceChange.create({ data: { planId: expired.plan.id, listPrice: 99000, salePrice: 69000, changedAt: new Date("2000-01-01") } });
    const changedAt = new Date(next.getTime() - DAY);
    await db.subscriptionPriceChange.create({ data: { planId: expired.plan.id, listPrice: 109000, salePrice: 79000, changedAt } });
    await db.subscriptionPlan.update({ where: { id: expired.plan.id }, data: { listPrice: 109000, salePrice: 79000 } });
    for (const [s, staleRegular] of [[discounted, true], [expired, false]] as const) {
      await db.sellerSubscription.create({ data: { sellerId: s.seller.id, planId: s.plan.id, regularPrice: staleRegular, subscribedAt: first, currentPeriodEnd: new Date(next.getTime() + DAY), nextChargeAt: next, billingKeyCipher: sealBillingKey("bk", s.seller.id) } });
    }
    const a = await createAdmin("SUPER_ADMIN");
    const token = (await createAdminSession(db, a.id, {})).token;
    const admin = (await resolveAdminSession(db, token))!;
    const kst = (d: Date) => new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    const invoices = await listBillingInvoices(db, admin, { from: kst(next), to: kst(next) });
    if (!invoices.ok) throw new Error("invoice query failed");
    expect(invoices.items.find(p => p.seller.id === discounted.seller.id)).toMatchObject({ amount: 69000, launchDiscount: true });
    expect(invoices.items.find(p => p.seller.id === expired.seller.id)).toMatchObject({ amount: 99000, launchDiscount: false });
    expect(invoices.summary.scheduled).toEqual({ count: 2, estimatedAmount: 168000 });
    expect((await getSubscriptionView(db, discounted.ctx, now)).plan?.nextAmount).toBe(69000);
    expect((await getSubscriptionView(db, expired.ctx, now)).plan?.nextAmount).toBe(99000);
  });

});

const BACKFILL = readFileSync(join(__dirname, "../../prisma/migrations/20261006290000_launch_discount_three_months/migration.sql"), "utf8").split(";").filter(s => /UPDATE/.test(s));
it("백필은 첫 유효 성공만 복구하고 기존 시각 보존·실패/환불 대상 제외·미사용 계정 보존·재실행 안전", async () => {
  const now = new Date();
  const s = await shop("INTEGRATED", null);
  const original = await shop("OVERLAY_ONLY", FIRST);
  const unpaid = await shop("INTEGRATED", null);
  for (const fixture of [s, original, unpaid]) await db.sellerSubscription.create({ data: { sellerId: fixture.seller.id, planId: fixture.plan.id, regularPrice: true } });
  const sub = await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
  const paidAt = new Date(now.getTime() - 20 * DAY);
  for (const [offset, status, refund] of [[-3, "FAILED", false], [-2, "PAID", true], [0, "PAID", false], [1, "PAID", false]] as const) {
    const at = new Date(paidAt.getTime() + offset * DAY);
    const p = await db.subscriptionPayment.create({ data: { sellerId: s.seller.id, subscriptionId: sub.id, amount: 179000, launchDiscount: true, status, paidAt: status === "PAID" ? at : null, periodStart: at, periodEnd: new Date(at.getTime() + DAY), createdAt: at } });
    if (refund) await db.auditLog.create({ data: { actorType: "SYSTEM", sellerId: s.seller.id, action: "subscription.refund_required", targetId: p.id } });
  }
  for (let n = 0; n < 2; n++) {
    for (const sql of BACKFILL) await db.$executeRawUnsafe(sql);
    expect(await used(s.seller.id)).toEqual(paidAt);
    expect(await used(original.seller.id)).toEqual(FIRST);
    expect(await used(unpaid.seller.id)).toBeNull();
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).regularPrice).toBe(false);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: original.seller.id } })).regularPrice).toBe(true);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: unpaid.seller.id } })).regularPrice).toBe(false);
  }
});
