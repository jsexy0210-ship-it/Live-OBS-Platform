import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AUTOMATION_CONSENT, AUTOMATION_PRICE } from "../../lib/server/automation/config";
import { cafe24Playbook } from "../../lib/server/automation/playbooks/cafe24";
import { PRACTICE_STREAK_REQUIRED } from "../../lib/server/automation/practice";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { confirmOneTimeAuthResult, purchaseAutomation, reconcileOneTimeAutomationPayments, reconcileOneTimeByTid, startOneTimeCardPurchase } from "../../lib/server/automation/purchase";
import { prisma } from "../../lib/server/db";
import { FakePaymentGateway } from "../../lib/server/payments/gateway";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-151 「다른 카드로 결제」(일반 결제창, 이번 한 번만). 가짜 PG로 돈은 움직이지 않는다.
const consent = { agreed: true, noticeVersion: AUTOMATION_CONSENT.version };
const SHOP = "https://myshop.cafe24.com";
let n = 0;
const newKey = () => `onetime-${Date.now()}-${++n}`;

beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
});
beforeEach(async () => {
  await resetDb();
  await db.automationPracticeRun.createMany({
    data: Array.from({ length: PRACTICE_STREAK_REQUIRED }, () => ({
      playbookId: cafe24Playbook.id,
      playbookVersion: cafe24Playbook.version,
      outcome: "SUCCEEDED" as const,
      durationMs: 1,
      plannerCalls: 0,
      playbookActions: 13,
      costWon: 0,
      startedAt: new Date(),
    })),
  });
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  // 저장 카드(빌링키)가 없어도 다른 카드로 결제할 수 있다
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, ctx };
}

async function start(ctx: TenantContext, gw: FakePaymentGateway, idempotencyKey = newKey()) {
  const r = await startOneTimeCardPurchase(db, gw, ctx, { idempotencyKey, consent, shopUrl: SHOP });
  if (!r.ok) throw new Error(r.reason);
  return r;
}
const payment = (id: string) => db.automationPayment.findUniqueOrThrow({ where: { id } });
const job = (id: string) => db.automationJob.findUniqueOrThrow({ where: { id } });

describe("다른 카드로 결제(일반 결제창)", () => {
  it("시작하면 결제창 값을 주고 결제 대기 작업만 만든다. 저장 카드는 건드리지 않는다", async () => {
    const { ctx, seller } = await shop();
    const gw = new FakePaymentGateway();
    const r = await start(ctx, gw);
    expect(r.window).toEqual({ clientId: "fake-client", method: "card", orderId: r.paymentId, amount: AUTOMATION_PRICE, goodsName: expect.any(String) });
    const p = await payment(r.paymentId);
    expect(p).toMatchObject({ method: "ONE_TIME_CARD", status: "PENDING", pgTid: null, amount: AUTOMATION_PRICE });
    expect((await job(r.jobId)).status).toBe("AWAITING_PAYMENT");
    expect(gw.approveCalls).toBe(0);
    expect((await db.sellerSubscription.findUnique({ where: { sellerId: seller.id } }))?.billingKeyCipher ?? null).toBeNull();
  });

  it("같은 키로 다시 요청하면 같은 결제창 값을 준다. 같은 키를 다른 수단에 쓰면 거부한다", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const key = newKey();
    const a = await start(ctx, gw, key);
    const b = await start(ctx, gw, key);
    expect(b).toMatchObject({ paymentId: a.paymentId, replayed: true });
    expect(await db.automationPayment.count()).toBe(1);
    // 같은 키를 구독 카드 결제 요청에 쓰면 처음 결과를 돌려주지 않고 거부한다
    expect(await purchaseAutomation(db, new FakeBillingProvider(), ctx, { idempotencyKey: key, consent, shopUrl: SHOP })).toMatchObject({ ok: false, reason: "idempotency_key_reused" });
  });

  it("인증 결과가 맞으면 서버가 승인하고 확인한 뒤에만 작업을 대기열에 넣는다(카드 요약 기록, 재전송은 승인 1회)", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const r = await start(ctx, gw);
    expect((await job(r.jobId)).status).toBe("AWAITING_PAYMENT");
    const auth = gw.authorize(r.paymentId, AUTOMATION_PRICE);
    const out = await confirmOneTimeAuthResult(db, gw, auth);
    expect(out).toMatchObject({ ok: true, outcome: "paid", jobId: r.jobId });
    const p = await payment(r.paymentId);
    expect(p).toMatchObject({ status: "PAID", pgTid: auth.tid, providerPaymentId: auth.tid, cardName: "시험카드", cardLast4: "1234" });
    expect((await job(r.jobId)).status).toBe("QUEUED");
    // 새로 고침으로 같은 결과가 다시 와도 승인은 한 번
    expect(await confirmOneTimeAuthResult(db, gw, auth)).toMatchObject({ ok: true, outcome: "paid" });
    expect(gw.approveCalls).toBe(1);
  });

  it("카드사가 거절하면 실패로 닫고, 다른 카드로 새로 시작할 수 있다", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const a = await start(ctx, gw);
    gw.failNext = "reject";
    const out = await confirmOneTimeAuthResult(db, gw, gw.authorize(a.paymentId, AUTOMATION_PRICE));
    expect(out).toMatchObject({ ok: true, outcome: "failed" });
    expect(await payment(a.paymentId)).toMatchObject({ status: "FAILED", failureReason: "card_declined" });
    expect(await job(a.jobId)).toMatchObject({ status: "FAILED", lastError: "payment_failed" });
    const b = await start(ctx, gw);
    expect(b.paymentId).not.toBe(a.paymentId);
    expect(b.window).not.toBeNull();
  });

  it("서명이 틀리거나 금액이 다르면 승인하지 않는다", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const a = await start(ctx, gw);
    const forged = { ...gw.authorize(a.paymentId, AUTOMATION_PRICE), signature: "bad" };
    expect(await confirmOneTimeAuthResult(db, gw, forged)).toEqual({ ok: false, reason: "invalid_signature" });
    expect(await confirmOneTimeAuthResult(db, gw, gw.authorize(a.paymentId, 1000))).toMatchObject({ ok: true, outcome: "failed" });
    expect(await payment(a.paymentId)).toMatchObject({ status: "FAILED", failureReason: "amount_mismatch", pgTid: null });
    expect(gw.approveCalls).toBe(0);
    expect(await confirmOneTimeAuthResult(db, gw, gw.authorize(crypto.randomUUID(), 1))).toEqual({ ok: false, reason: "not_found" });
  });

  it("인증 실패(서명 없음)로는 상태를 바꾸지 않고 사유만 로그 추적에 남긴다", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const a = await start(ctx, gw);
    const out = await confirmOneTimeAuthResult(db, gw, { authResultCode: "A123", authResultMsg: "취소", tid: "", clientId: "", orderId: a.paymentId, amount: "", authToken: "", signature: "" });
    expect(out).toMatchObject({ ok: true, outcome: "failed" });
    expect((await payment(a.paymentId)).status).toBe("PENDING");
    expect(await db.auditLog.count({ where: { action: "automation.one_time_auth_failed", targetId: a.paymentId } })).toBe(1);
  });

  it("승인 응답이 없으면 망 취소로 거두고 실패로 닫는다", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const a = await start(ctx, gw);
    gw.failNext = "timeout_before";
    const out = await confirmOneTimeAuthResult(db, gw, gw.authorize(a.paymentId, AUTOMATION_PRICE));
    expect(out).toMatchObject({ ok: true, outcome: "failed" });
    expect(await payment(a.paymentId)).toMatchObject({ status: "FAILED", failureReason: "approve_timeout" });
  });

  it("이미 결제된(진행 중) 작업이 있으면 다른 카드로도 중복 결제하지 않는다", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const a = await start(ctx, gw);
    await confirmOneTimeAuthResult(db, gw, gw.authorize(a.paymentId, AUTOMATION_PRICE));
    const again = await startOneTimeCardPurchase(db, gw, ctx, { idempotencyKey: newKey(), consent, shopUrl: SHOP });
    expect(again).toMatchObject({ ok: false, reason: "job_in_progress" });
    expect(await db.automationPayment.count()).toBe(1);
  });

  it("결제창을 열고 끝내지 않은 시도는 다음 시도에서 닫히고, 늦게 온 인증으로는 승인하지 않는다", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const a = await start(ctx, gw);
    const b = await start(ctx, gw);
    expect(await payment(a.paymentId)).toMatchObject({ status: "FAILED", failureReason: "window_abandoned" });
    expect(await job(a.jobId)).toMatchObject({ status: "FAILED" });
    const late = await confirmOneTimeAuthResult(db, gw, gw.authorize(a.paymentId, AUTOMATION_PRICE));
    expect(late).toMatchObject({ ok: true, outcome: "failed" });
    expect(gw.approveCalls).toBe(0);
    expect((await job(b.jobId)).status).toBe("AWAITING_PAYMENT");
  });

  it("동의가 없으면 결제를 만들지 않고, 카드 정보는 저장하지 않는다", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const r = await startOneTimeCardPurchase(db, gw, ctx, { idempotencyKey: newKey(), consent: { agreed: false, noticeVersion: AUTOMATION_CONSENT.version }, shopUrl: SHOP });
    expect(r).toMatchObject({ ok: false, reason: "consent_required" });
    expect(await db.automationPayment.count()).toBe(0);
  });

  it("대사: 승인 결과를 못 받은 결제는 거래 id로 PG에 물어 확정한다(대사·웹훅 공통)", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const a = await start(ctx, gw);
    const auth = gw.authorize(a.paymentId, AUTOMATION_PRICE);
    // 승인 요청은 나갔고(결제 행에 거래 id) PG는 결제했지만 우리가 결과를 못 받은 상태
    await db.automationPayment.update({ where: { id: a.paymentId }, data: { pgTid: auth.tid, chargeSubmittedAt: new Date(), chargeFirstSubmittedAt: new Date() } });
    await gw.approve({ tid: auth.tid, amount: AUTOMATION_PRICE });
    expect(await reconcileOneTimeAutomationPayments(db, gw, { olderThanMs: 0 })).toBe(1);
    expect(await payment(a.paymentId)).toMatchObject({ status: "PAID", cardLast4: "1234" });
    expect((await job(a.jobId)).status).toBe("QUEUED");
    expect(await reconcileOneTimeByTid(db, gw, auth.tid)).toBe(true);
    expect(await reconcileOneTimeByTid(db, gw, "unknown-tid")).toBe(false);
  });

  it("대사: 결제창만 열고 30분이 지난 결제는 실패로 닫는다", async () => {
    const { ctx } = await shop();
    const gw = new FakePaymentGateway();
    const a = await start(ctx, gw);
    await db.automationPayment.update({ where: { id: a.paymentId }, data: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    expect(await reconcileOneTimeAutomationPayments(db, gw, { olderThanMs: 0 })).toBe(1);
    expect(await payment(a.paymentId)).toMatchObject({ status: "FAILED", failureReason: "window_abandoned" });
    expect((await job(a.jobId)).status).toBe("FAILED");
  });
});
