import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SubscriptionPriceNoticeChannel } from "@prisma/client";
import { chargeFor, dbNow, getSubscriptionView, reconcileStalePayments, renewDueSubscriptions } from "../../lib/server/billing/subscription";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { createSeller, db, resetDb } from "./helpers";

const DAY = 86400_000;
const channels: SubscriptionPriceNoticeChannel[] = ["MAIL", "ALIMTALK", "PARTNERS_NOTICE"];
beforeEach(resetDb);
beforeAll(() => { process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef"; });
afterAll(() => db.$disconnect());

async function fixture() {
  const now = await dbNow(db);
  const { seller } = await createSeller();
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } });
  const sub = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id, subscribedAt: new Date(+now - 90 * DAY) } });
  await db.subscriptionPriceChange.create({ data: { planId: plan.id, listPrice: plan.listPrice, salePrice: plan.salePrice, changedAt: new Date("2000-01-01") } });
  const change = await db.subscriptionPriceChange.create({ data: { planId: plan.id, listPrice: 350000, salePrice: 249000, changedAt: new Date(+now - 60 * DAY) } });
  const updatedPlan = await db.subscriptionPlan.update({ where: { id: plan.id }, data: { listPrice: change.listPrice, salePrice: change.salePrice } });
  return { now, sub, plan: updatedPlan, change, completedAt: new Date(+change.changedAt + DAY) };
}

async function receipts(f: Awaited<ReturnType<typeof fixture>>) {
  // 합성 완료 근거만 넣는다. 외부 송신·실제 고지 성공을 검증하는 시험이 아니다.
  await db.subscriptionPriceNotice.createMany({ data: channels.map((channel) => ({
    subscriptionId: f.sub.id, subscriptionStartedAt: f.sub.subscribedAt, priceChangeId: f.change.id,
    channel, status: "SENT" as const, completedAt: f.completedAt, deliveryReference: `synthetic:${channel}`,
  })) });
}

describe("기존 구독 가격 고지 보호", () => {
  it.each(["missing", "pending", "failed", "partial"] as const)("%s 고지는 변경 30일이 지나도 구가를 유지한다", async (state) => {
    const f = await fixture();
    if (state !== "missing") {
      await receipts(f);
      await db.subscriptionPriceNotice.updateMany({ where: { subscriptionId: f.sub.id, ...(state === "partial" ? { channel: "ALIMTALK" as const } : {}) }, data: { status: state === "failed" || state === "partial" ? "FAILED" : "PENDING" } });
    }
    expect((await chargeFor(db, f.plan, f.sub, f.now)).amount).toBe(199000);
  });

  it("가장 늦은 필수 채널 완료부터 30일 경계·정가/판매가를 적용한다", async () => {
    const f = await fixture();
    await receipts(f);
    const latest = new Date(+f.completedAt + 2 * DAY);
    await db.subscriptionPriceNotice.updateMany({ where: { subscriptionId: f.sub.id, channel: "ALIMTALK" }, data: { completedAt: latest } });
    const boundary = new Date(+latest + 30 * DAY);
    expect((await chargeFor(db, f.plan, f.sub, new Date(+boundary - 1))).amount).toBe(199000);
    expect((await chargeFor(db, f.plan, f.sub, boundary)).amount).toBe(249000);
    expect(await chargeFor(db, f.plan, { ...f.sub, regularPrice: true }, boundary)).toMatchObject({ amount: 350000, launchDiscount: false });
  });

  it.each(["before_change", "future", "no_time", "no_reference"] as const)("%s 완료 근거는 성공으로 인정하지 않는다", async (state) => {
    const f = await fixture();
    await receipts(f);
    await db.subscriptionPriceNotice.updateMany({ where: { subscriptionId: f.sub.id, channel: "MAIL" }, data:
      state === "no_reference" ? { deliveryReference: null } : { completedAt: state === "no_time" ? null : new Date(state === "future" ? +f.now + DAY : +f.change.changedAt - 1) } });
    // 다음 결제를 미래로 미리 보더라도 미래의 발송 완료 기록은 현재 관측된 증거가 아니다.
    expect((await chargeFor(db, f.plan, f.sub, new Date(+f.now + 60 * DAY))).amount).toBe(199000);
  });

  it("다른 판매자·이전 구독 epoch의 완료를 재사용하지 않는다", async () => {
    const f = await fixture();
    const { seller } = await createSeller();
    const other = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: f.plan.id, subscribedAt: f.sub.subscribedAt } });
    await receipts({ ...f, sub: other });
    expect((await chargeFor(db, f.plan, f.sub, f.now)).amount).toBe(199000);
    await receipts(f);
    expect((await chargeFor(db, f.plan, { ...f.sub, subscribedAt: new Date(+f.sub.subscribedAt + DAY) }, f.now)).amount).toBe(199000);
  });

  it("동일 채널 중복은 거절하며 같은 근거의 재조회는 시각·금액을 바꾸지 않는다", async () => {
    const f = await fixture();
    await receipts(f);
    const receipt = await db.subscriptionPriceNotice.findFirstOrThrow({ where: { subscriptionId: f.sub.id, channel: "MAIL" } });
    const { id: _id, ...copy } = receipt;
    await expect(db.subscriptionPriceNotice.create({ data: copy })).rejects.toMatchObject({ code: "P2002" });
    expect((await chargeFor(db, f.plan, f.sub, f.now)).amount).toBe(249000);
    expect((await chargeFor(db, f.plan, f.sub, f.now)).amount).toBe(249000);
    expect((await db.subscriptionPriceNotice.findUniqueOrThrow({ where: { id: receipt.id } })).completedAt).toEqual(f.completedAt);
  });

  it("후속 미고지 변경으로 앞선 완료 요금을 덮어쓰지 않고 신규·재가입은 현재 가격이다", async () => {
    const f = await fixture();
    await receipts(f);
    await db.subscriptionPriceChange.create({ data: { planId: f.plan.id, listPrice: 400000, salePrice: 280000, changedAt: new Date(+f.now - 40 * DAY) } });
    expect((await chargeFor(db, f.plan, f.sub, f.now)).amount).toBe(249000);
    expect((await chargeFor(db, f.plan, { ...f.sub, subscribedAt: f.now }, f.now)).amount).toBe(280000);
    const { id: _id, ...fresh } = f.sub;
    expect((await chargeFor(db, f.plan, { ...fresh, subscribedAt: f.now }, f.now)).amount).toBe(280000);
  });

  it("기존 STANDARD 이전 고지 보호와 30일 경계를 유지한다", async () => {
    const f = await fixture();
    const legacy = { ...f.sub, legacyPrice: 150000 };
    expect(await chargeFor(db, f.plan, legacy, f.now)).toMatchObject({ amount: 150000, launchDiscount: false });
    await receipts(f);
    const notified = { ...legacy, legacyPriceNoticeSentAt: f.completedAt };
    expect((await chargeFor(db, f.plan, notified, new Date(+f.completedAt + 30 * DAY - 1))).amount).toBe(150000);
    expect((await chargeFor(db, f.plan, notified, new Date(+f.completedAt + 30 * DAY))).amount).toBe(249000);
  });

  it("구독 당시 가격 이력이 사라져도 현재 변경 요금으로 대체하지 않는다", async () => {
    const f = await fixture();
    await db.subscriptionPriceChange.deleteMany({ where: { changedAt: { lt: f.sub.subscribedAt } } });
    await expect(chargeFor(db, f.plan, f.sub, f.now)).rejects.toThrow("subscription_price_baseline_missing");
  });

  it("baseline 누락 갱신은 청구·외부 호출 전 중단하고 정상 미고지 구독 화면은 구가를 보여준다", async () => {
    const f = await fixture();
    const sub = await db.sellerSubscription.update({ where: { id: f.sub.id }, data: {
      billingKeyCipher: sealBillingKey("synthetic-key", f.sub.sellerId), nextChargeAt: f.now,
      currentPeriodStart: new Date(+f.now - 30 * DAY), currentPeriodEnd: f.now, billingAnchorAt: new Date(+f.now - 30 * DAY),
    } });
    const view = await getSubscriptionView(db, { sellerId: sub.sellerId, actorId: "synthetic-owner", actorType: "SELLER_USER", isOwner: true, permissions: [], readOnly: false }, f.now);
    expect(view.plan?.nextAmount).toBe(199000);
    await db.subscriptionPriceChange.deleteMany({ where: { changedAt: { lt: f.sub.subscribedAt } } });
    const provider = new FakeBillingProvider();
    expect(await renewDueSubscriptions(db, provider, { now: f.now, only: [sub.id] })).toMatchObject({ charged: 0, errors: 1 });
    expect(provider.charges).toHaveLength(0);
    expect(await db.subscriptionPayment.count()).toBe(0);
  });

  it.each(["unnotified", "epoch", "no_baseline", "correct", "already_paid"] as const)("정기 청구 NOT_FOUND 재시도 %s는 고지 보호를 우회하지 않는다", async (state) => {
    const f = await fixture();
    await db.sellerSubscription.update({ where: { id: f.sub.id }, data: { billingKeyCipher: sealBillingKey("synthetic-key", f.sub.sellerId) } });
    const payment = await db.subscriptionPayment.create({ data: {
      subscriptionId: f.sub.id, sellerId: f.sub.sellerId, amount: state === "correct" ? 199000 : 249000,
      createdAt: new Date(+f.now - DAY), periodStart: f.now, periodEnd: new Date(+f.now + 30 * DAY), scheduled: true,
    } });
    if (state === "epoch") await db.sellerSubscription.update({ where: { id: f.sub.id }, data: { subscribedAt: f.now } });
    if (state === "no_baseline") await db.subscriptionPriceChange.deleteMany({ where: { changedAt: { lt: f.sub.subscribedAt } } });
    const provider = new FakeBillingProvider();
    if (state === "already_paid") await provider.charge({ orderId: payment.id, billingKey: "synthetic-key", customerKey: f.sub.sellerId, amount: payment.amount, orderName: "합성 시험" });
    const beforeCalls = provider.charges.length;
    const result = await reconcileStalePayments(db, provider, { now: f.now, staleMs: 0 });
    if (state === "correct" || state === "already_paid") {
      expect(result).toMatchObject({ paid: 1, recharged: state === "correct" ? 1 : 0 });
    } else {
      expect(result).toMatchObject({ unresolved: 1, recharged: 0 });
      expect((await db.subscriptionPayment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe("PENDING");
    }
    expect(provider.charges.length - beforeCalls).toBe(state === "correct" ? 1 : 0);
  });

  it.each(["PRORATION", "PERIOD"] as const)("플랜 변경 %s 재시도도 당시 고지된 두 금액·기존 일할계산과 일치할 때만 청구한다", async (kind) => {
    const f = await fixture();
    await db.sellerSubscription.update({ where: { id: f.sub.id }, data: {
      billingKeyCipher: sealBillingKey("synthetic-key", f.sub.sellerId), status: kind === "PERIOD" ? "PAST_DUE" : "ACTIVE",
      currentPeriodStart: new Date(+f.now - (kind === "PERIOD" ? 45 : 15) * DAY),
      currentPeriodEnd: new Date(+f.now + (kind === "PERIOD" ? -15 : 15) * DAY),
    } });
    const target = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
    await db.subscriptionPriceChange.createMany({ data: [
      { planId: target.id, listPrice: 400000, salePrice: 299000, changedAt: new Date("2000-01-01") },
      { planId: target.id, listPrice: 500000, salePrice: 399000, changedAt: new Date(+f.now - 60 * DAY) },
    ] });
    await db.subscriptionPlan.update({ where: { id: target.id }, data: { listPrice: 500000, salePrice: 399000 } });
    // 30일 중 16일이 남음. 승인된 구가 차액 100,000원의 일할 금액은 53,333원.
    const payment = await db.subscriptionPayment.create({ data: {
      subscriptionId: f.sub.id, sellerId: f.sub.sellerId, targetPlanId: target.id, kind,
      amount: kind === "PRORATION" ? 106666 : 305666,
      createdAt: new Date(+f.now - DAY), periodStart: new Date(+f.now - 15 * DAY), periodEnd: new Date(+f.now + 15 * DAY),
    } });
    const provider = new FakeBillingProvider();
    expect(await reconcileStalePayments(db, provider, { now: f.now, staleMs: 0 })).toMatchObject({ unresolved: 1, recharged: 0 });
    expect(provider.charges).toHaveLength(0);
    await db.subscriptionPayment.update({ where: { id: payment.id }, data: { amount: kind === "PRORATION" ? 53333 : 252333 } });
    expect(await reconcileStalePayments(db, provider, { now: f.now, staleMs: 0 })).toMatchObject({ paid: 1, recharged: 1 });
    expect(provider.charges[0].amount).toBe(kind === "PRORATION" ? 53333 : 252333);
  });
});
