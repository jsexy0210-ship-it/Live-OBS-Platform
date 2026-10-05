import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PUT as adminSettingsPut } from "../../app/api/admin/message-settings/route";
import { GET as chargesGet, POST as chargesPost } from "../../app/api/seller/message-balance/charges/route";
import { SCHEDULED_JOBS, runScheduledJobs } from "../../lib/server/jobs/scheduler";
import { loginSeller } from "../../lib/server/auth/login";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { billingProvider } from "../../lib/server/billing/registry";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { prisma } from "../../lib/server/db";
import { type MailSender, sendMail } from "../../lib/server/mail/quota";
import { MESSAGE_FEE_NOTICE_VERSION, reserveDebit } from "../../lib/server/messaging/balance";
import { chargeMessageBalance, reconcileMessageCharges, settleMessageCharge } from "../../lib/server/messaging/charge";
import { STALE_DEBIT_HOLD_MS, STALE_MAIL_HOLD_MS, expireStaleMessageHolds } from "../../lib/server/messaging/holds";
import { MESSAGE_JOB_NAME, runMessageJobs } from "../../lib/server/messaging/jobs";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 발송 충전(카드 결제, 가짜 공급자만)·충전 스위치·멈춘 예약 정리(docs/terms/SELLER_MESSAGE_FEE_NOTICE.md 2·3·7절)
beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
  process.env.BILLING_PROVIDER = "fake";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const BK = "fake-bk-card-1";

async function shop(opts: { card?: boolean; consent?: boolean; charging?: boolean } = {}) {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "INTEGRATED" } });
  await db.seller.update({ where: { id: seller.id }, data: { planId: plan.id } });
  if (opts.card ?? true) await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id, billingKeyCipher: sealBillingKey(BK, seller.id), cardLabel: "테스트카드 1234" } });
  if (opts.consent ?? true) await db.sellerMessageFeeConsent.create({ data: { sellerId: seller.id, version: MESSAGE_FEE_NOTICE_VERSION, sellerUserId: owner.id, consentedAt: new Date() } });
  if (opts.charging ?? true) await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, chargingEnabled: true }, update: { chargingEnabled: true } });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, owner, ctx };
}
const paid = async (sellerId: string) => (await db.sellerMessageBalance.findUnique({ where: { sellerId } }))?.paidBalance ?? 0;

describe("발송 충전", () => {
  it("구독 카드로 결제하면 유료 잔액이 늘고 원장 CHARGE·로그 추적이 남는다. 같은 키로 다시 보내면 결제하지 않는다", async () => {
    const s = await shop();
    const provider = new FakeBillingProvider();
    const r = await chargeMessageBalance(db, provider, s.ctx, { amount: 10_000, idempotencyKey: "c1" });
    expect(r).toMatchObject({ ok: true, charge: { amount: 10_000, status: "PAID" } });
    expect(provider.charges).toEqual([{ orderId: r.ok ? r.charge.id : "", amount: 10_000, billingKey: BK }]);
    expect(await paid(s.seller.id)).toBe(10_000);
    expect(await db.sellerMessageLedger.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id } })).toMatchObject({ type: "CHARGE", status: "SUCCEEDED", paidAmount: 10_000, freeAmount: 0, actorId: s.owner.id });
    expect(await db.messageCharge.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id } })).toMatchObject({ noticeVersion: MESSAGE_FEE_NOTICE_VERSION, sellerUserId: s.owner.id });
    expect(await db.auditLog.count({ where: { action: { in: ["seller.message_charge.request", "seller.message_charge.paid"] } } })).toBe(2);
    const again = await chargeMessageBalance(db, provider, s.ctx, { amount: 10_000, idempotencyKey: "c1" });
    expect(again).toMatchObject({ ok: true, charge: { status: "PAID" } });
    expect(provider.charges).toHaveLength(1);
    expect(await paid(s.seller.id)).toBe(10_000);
  });

  it("충전 스위치가 꺼졌거나·동의 전·카드 없음·금액이 틀리면 결제하지 않는다", async () => {
    const provider = new FakeBillingProvider();
    const off = await shop({ charging: false });
    expect(await chargeMessageBalance(db, provider, off.ctx, { amount: 5_000, idempotencyKey: "a" })).toEqual({ ok: false, reason: "charging_disabled" });
    const noConsent = await shop({ consent: false });
    expect(await chargeMessageBalance(db, provider, noConsent.ctx, { amount: 5_000, idempotencyKey: "a" })).toEqual({ ok: false, reason: "consent_required" });
    // 예전 서식 버전에만 동의했으면 다시 동의해야 한다
    await db.sellerMessageFeeConsent.create({ data: { sellerId: noConsent.seller.id, version: "2026-01-01", sellerUserId: noConsent.owner.id, consentedAt: new Date() } });
    expect(await chargeMessageBalance(db, provider, noConsent.ctx, { amount: 5_000, idempotencyKey: "a" })).toEqual({ ok: false, reason: "consent_required" });
    const noCard = await shop({ card: false });
    expect(await chargeMessageBalance(db, provider, noCard.ctx, { amount: 5_000, idempotencyKey: "a" })).toEqual({ ok: false, reason: "card_required" });
    const s = await shop();
    for (const amount of [999, 1_500, 1_001_000, "5000", 0]) expect(await chargeMessageBalance(db, provider, s.ctx, { amount, idempotencyKey: "a" })).toEqual({ ok: false, reason: "invalid_charge" });
    expect(await chargeMessageBalance(db, provider, s.ctx, { amount: 5_000, idempotencyKey: "" })).toEqual({ ok: false, reason: "invalid_charge" });
    expect(provider.charges).toHaveLength(0);
    expect(await db.messageCharge.count()).toBe(0);
  });

  it("카드 거절이면 FAILED로 남고 잔액은 그대로", async () => {
    const s = await shop();
    const provider = new FakeBillingProvider();
    provider.decline(BK);
    expect(await chargeMessageBalance(db, provider, s.ctx, { amount: 5_000, idempotencyKey: "d" })).toMatchObject({ ok: true, charge: { status: "FAILED", failureReason: "card_declined" } });
    expect(await paid(s.seller.id)).toBe(0);
    expect(await db.sellerMessageLedger.count()).toBe(0);
  });

  it("결제 응답이 끊기면 PENDING으로 두고, 같은 키 재요청·대조가 공급자 조회로 한 번만 확정한다(두 번 결제·두 번 적립 없음)", async () => {
    const s = await shop();
    const provider = new FakeBillingProvider();
    provider.failNext = "timeout_after_charge";
    const r = await chargeMessageBalance(db, provider, s.ctx, { amount: 7_000, idempotencyKey: "t" });
    expect(r).toMatchObject({ ok: true, charge: { status: "PENDING" } });
    expect(await paid(s.seller.id)).toBe(0);
    // 같은 키로 다시 보내면 공급자 조회로 확정(다시 결제하지 않음)
    expect(await chargeMessageBalance(db, provider, s.ctx, { amount: 7_000, idempotencyKey: "t" })).toMatchObject({ ok: true, charge: { status: "PAID" } });
    expect(provider.charges).toHaveLength(1);
    expect(await paid(s.seller.id)).toBe(7_000);
    // 이미 확정된 충전을 다시 확정해도 잔액은 한 번만
    if (!r.ok) throw new Error();
    await settleMessageCharge(db, r.charge.id, { ok: true, paymentId: "x", receiptUrl: null });
    expect(await paid(s.seller.id)).toBe(7_000);
    expect(await db.sellerMessageLedger.count({ where: { type: "CHARGE" } })).toBe(1);
  });

  it("대조: 1분 지난 PENDING을 공급자 결과로 확정하고, 공급자에 기록이 없으면 10분 뒤 결제 안 됨으로 닫는다", async () => {
    const s = await shop();
    const provider = new FakeBillingProvider();
    provider.failNext = "timeout_after_charge";
    await chargeMessageBalance(db, provider, s.ctx, { amount: 3_000, idempotencyKey: "p1" });
    provider.failNext = "timeout_before_charge";
    await chargeMessageBalance(db, provider, s.ctx, { amount: 4_000, idempotencyKey: "p2" });
    const now = new Date(Date.now() + 2 * 60_000);
    expect(await reconcileMessageCharges(db, provider, { now })).toEqual({ paid: 1, failed: 0, pending: 1, errors: 0, truncated: false });
    expect(await paid(s.seller.id)).toBe(3_000);
    expect(await reconcileMessageCharges(db, provider, { now: new Date(Date.now() + 11 * 60_000) })).toEqual({ paid: 0, failed: 1, pending: 0, errors: 0, truncated: false });
    expect(await db.messageCharge.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { idempotencyKey: "p2" } })).toMatchObject({ status: "FAILED", failureReason: "not_charged" });
    expect(await paid(s.seller.id)).toBe(3_000);
  });

  it("동시성: 같은 키 충전 6번을 한꺼번에 보내도 결제·적립은 한 번", async () => {
    const s = await shop();
    const provider = new FakeBillingProvider();
    const rs = await Promise.all(Array.from({ length: 6 }, () => chargeMessageBalance(db, provider, s.ctx, { amount: 2_000, idempotencyKey: "same" })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(provider.charges).toHaveLength(1);
    expect(await db.messageCharge.count()).toBe(1);
    expect(await paid(s.seller.id)).toBe(2_000);
  });
});

describe("충전 API", () => {
  const post = (cookie: string, body: unknown) =>
    chargesPost(new Request("http://localhost:3000/api/seller/message-balance/charges", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  const get = (cookie: string) => chargesGet(new Request("http://localhost:3000/api/seller/message-balance/charges", { headers: { ...H, cookie } }));
  async function cookieOf(email: string) {
    const r = await loginSeller(db, { email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_seller=${r.token}`;
  }

  it("대표자 충전 200·거절 402, 꺼짐 403·동의 전 409·잘못된 금액 400, 직원 403, 정지 중엔 충전 403·내역 보기만", async () => {
    const s = await shop();
    const cookie = await cookieOf(s.owner.email);
    const ok = await post(cookie, { amount: 3_000, idempotencyKey: "r1" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ charge: { amount: 3_000, status: "PAID" } });
    const list = await (await get(cookie)).json();
    expect(list).toMatchObject({ balance: { paidBalance: 3_000 }, charges: [{ amount: 3_000, status: "PAID" }] });

    (billingProvider() as FakeBillingProvider).decline(BK);
    const declined = await post(cookie, { amount: 3_000, idempotencyKey: "r2" });
    expect(declined.status).toBe(402);
    expect(await declined.json()).toMatchObject({ charge: { status: "FAILED" }, message: expect.any(String) });
    expect((await post(cookie, { amount: 3_500, idempotencyKey: "r3" })).status).toBe(400);

    const staff = await createSellerUser(s.seller.id, { permissions: ["SHOP_SETTINGS"] });
    const staffCookie = await cookieOf(staff.email);
    expect((await post(staffCookie, { amount: 3_000, idempotencyKey: "s1" })).status).toBe(403);
    expect((await get(staffCookie)).status).toBe(403);

    const noConsent = await shop({ consent: false });
    const r409 = await post(await cookieOf(noConsent.owner.email), { amount: 3_000, idempotencyKey: "n1" });
    expect(r409.status).toBe(409);
    expect(await r409.json()).toMatchObject({ error: "consent_required" });

    await db.platformMessageSetting.update({ where: { id: 1 }, data: { chargingEnabled: false } });
    expect((await post(cookie, { amount: 3_000, idempotencyKey: "r4" })).status).toBe(403);

    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await get(cookie)).status).toBe(200);
    await db.platformMessageSetting.update({ where: { id: 1 }, data: { chargingEnabled: true } });
    expect((await post(cookie, { amount: 3_000, idempotencyKey: "r5" })).status).toBe(403);
  });
});

describe("충전 스위치가 꺼진 동안은 차감하지 않는다", () => {
  it("단가가 있어도 차감하지 않고 charging_disabled, 메일은 제공량을 넘으면 차감 없이 미발송", async () => {
    const s = await shop({ charging: false });
    await db.subscriptionPlan.update({ where: { code: "INTEGRATED" }, data: { mailMonthlyQuota: 0 } });
    await db.messageChannelPrice.create({ data: { channel: "MAIL_TRANSACTIONAL", unitPrice: 10 } });
    await db.sellerMessageBalance.create({ data: { sellerId: s.seller.id, paidBalance: 100 } });
    const sender: MailSender = { send: async () => ({ providerMessageId: "m" }) };
    expect(await sendMail(db, sender, { sellerId: s.seller.id, kind: "t", message: { to: "a@b.co", subject: "s", html: "h" } })).toMatchObject({ status: "SKIPPED_BALANCE" });
    expect(await db.$transaction((tx) => reserveDebit(tx, { sellerId: s.seller.id, channel: "MAIL_TRANSACTIONAL", idempotencyKey: "k" }))).toMatchObject({ ok: false, reason: "charging_disabled" });
    expect(await paid(s.seller.id)).toBe(100);
    expect(await db.sellerMessageLedger.count()).toBe(0);
  });
});

describe("멈춘 예약 정리", () => {
  it("15분 넘게 보내는 중인 메일은 실패로 닫고 차감을 되돌린다. 30분 넘은 다른 차감도 되돌린다. 최근 것·확정된 것은 그대로", async () => {
    const s = await shop();
    await db.subscriptionPlan.update({ where: { code: "INTEGRATED" }, data: { mailMonthlyQuota: 0 } });
    await db.messageChannelPrice.createMany({ data: [{ channel: "MAIL_TRANSACTIONAL", unitPrice: 10 }, { channel: "SMS", unitPrice: 20 }] });
    await db.sellerMessageBalance.create({ data: { sellerId: s.seller.id, paidBalance: 100 } });
    const { reserveMail } = await import("../../lib/server/mail/quota");
    const old = await reserveMail(db, { sellerId: s.seller.id, kind: "t" });
    const fresh = await reserveMail(db, { sellerId: s.seller.id, kind: "t" });
    const sms = await db.$transaction((tx) => reserveDebit(tx, { sellerId: s.seller.id, channel: "SMS", idempotencyKey: "sms-1" }));
    expect([old.ok, fresh.ok, sms.ok]).toEqual([true, true, true]);
    expect(await paid(s.seller.id)).toBe(60);
    if (!old.ok || !sms.ok) throw new Error();
    await db.mailDelivery.update({ where: { id: old.deliveryId }, data: { createdAt: new Date(Date.now() - STALE_MAIL_HOLD_MS - 1000) } });
    await db.sellerMessageLedger.update({ where: { id: old.ledgerId! }, data: { createdAt: new Date(Date.now() - STALE_DEBIT_HOLD_MS - 1000) } });
    await db.sellerMessageLedger.update({ where: { id: sms.ledgerId }, data: { createdAt: new Date(Date.now() - STALE_DEBIT_HOLD_MS - 1000) } });
    expect(await expireStaleMessageHolds(db)).toEqual({ mailsFailed: 1, debitsReleased: 1, truncated: false });
    expect(await db.mailDelivery.findUniqueOrThrow({ where: { id: old.deliveryId } })).toMatchObject({ status: "FAILED" });
    expect(await db.mailDelivery.findUniqueOrThrow({ where: { id: fresh.deliveryId } })).toMatchObject({ status: "PENDING" });
    expect(await paid(s.seller.id)).toBe(90);
    expect(await expireStaleMessageHolds(db)).toEqual({ mailsFailed: 0, debitsReleased: 0, truncated: false });
  });
});

describe("발송 충전 정기 작업과 충전 켜기 조건", () => {
  const H2 = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
  const put = (cookie: string, body: unknown) =>
    adminSettingsPut(new Request("http://localhost:3000/api/admin/message-settings", { method: "PUT", headers: { ...H2, cookie }, body: JSON.stringify(body) }));
  const beat = (lastOkAt: Date | null, lastStatus = "done") =>
    db.opsHeartbeat.create({ data: { instance: "test", generation: "g1", job: MESSAGE_JOB_NAME, lastRunAt: lastOkAt ?? new Date(), lastStatus, lastOkAt } });

  it("정기 실행 목록에 들어 있고, 한 번 돌면 멈춘 메일 예약을 닫고 응답이 끊긴 충전을 확정한다", async () => {
    expect(SCHEDULED_JOBS.map((j) => j.name)).toContain(MESSAGE_JOB_NAME);
    const s = await shop();
    // 앞 시험이 전역 공급자에서 거절로 바꾼 카드와 다른 카드
    await db.sellerSubscription.update({ where: { sellerId: s.seller.id }, data: { billingKeyCipher: sealBillingKey("fake-bk-job", s.seller.id) } });
    // 응답이 끊긴 충전(가짜 공급자에는 결제됨) — 라우트와 같은 공급자(registry)
    const provider = billingProvider() as FakeBillingProvider;
    provider.failNext = "timeout_after_charge";
    const r = await chargeMessageBalance(db, provider, s.ctx, { amount: 5_000, idempotencyKey: "job" });
    expect(r).toMatchObject({ ok: true, charge: { status: "PENDING" } });
    await db.messageCharge.updateMany({ data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    // 멈춘 메일 예약(잔액 10원 차감 중)
    await db.subscriptionPlan.update({ where: { code: "INTEGRATED" }, data: { mailMonthlyQuota: 0 } });
    await db.messageChannelPrice.create({ data: { channel: "MAIL_TRANSACTIONAL", unitPrice: 10 } });
    await db.sellerMessageBalance.create({ data: { sellerId: s.seller.id, freeBalance: 10 } });
    const { reserveMail } = await import("../../lib/server/mail/quota");
    const m = await reserveMail(db, { sellerId: s.seller.id, kind: "t" });
    expect(m.ok).toBe(true);
    await db.mailDelivery.updateMany({ data: { createdAt: new Date(Date.now() - STALE_MAIL_HOLD_MS - 1000) } });
    const out = await runScheduledJobs(db, new Date());
    expect(out.find((o) => o.name === MESSAGE_JOB_NAME)).toEqual({ name: MESSAGE_JOB_NAME, status: "done", count: 2 });
    expect(await db.messageCharge.findFirstOrThrow()).toMatchObject({ status: "PAID" });
    expect((await db.mailDelivery.findFirstOrThrow()).status).toBe("FAILED");
    expect(await db.sellerMessageBalance.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).toMatchObject({ paidBalance: 5_000, freeBalance: 10 });
    expect(provider.charges.filter((c) => c.amount === 5_000)).toHaveLength(1);
  });

  it("충전 켜기는 이 작업이 2시간 안에 성공한 기록이 있어야 한다(없음·오래됨·실패면 409). 끄기는 언제든", async () => {
    const { createAdmin } = await import("./helpers");
    const { createAdminSession } = await import("../../lib/server/auth/session");
    const su = await createAdmin("SUPER_ADMIN");
    const cookie = `lo_admin=${(await createAdminSession(db, su.id, {})).token}`;
    const r1 = await put(cookie, { chargingEnabled: true });
    expect(r1.status).toBe(409);
    expect(await r1.json()).toMatchObject({ error: "jobs_not_running" });
    await beat(new Date(Date.now() - 3 * 3600_000));
    expect((await put(cookie, { chargingEnabled: true })).status).toBe(409);
    await db.opsHeartbeat.deleteMany();
    await beat(new Date(), "failed");
    expect((await put(cookie, { chargingEnabled: true })).status).toBe(409);
    expect((await db.platformMessageSetting.findUnique({ where: { id: 1 } }))?.chargingEnabled ?? false).toBe(false);
    await db.opsHeartbeat.deleteMany();
    await beat(new Date());
    const ok = await put(cookie, { chargingEnabled: true });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ chargingEnabled: true });
    // 켜진 뒤 다른 값만 바꾸는 것·끄기는 작업 기록과 상관없이 된다
    await db.opsHeartbeat.deleteMany();
    expect((await put(cookie, { platformDailyLimit: 50 })).status).toBe(200);
    expect(await (await put(cookie, { chargingEnabled: false })).json()).toMatchObject({ chargingEnabled: false });
  });
});

describe("정기 작업 처리 시간 예산(스케줄러 60초 제한 안에서 끝내고 다음 실행이 이어서 처리)", () => {
  it("공급자 조회가 느리면 예산 안에서 멈추고(다음 건을 시작하지 않음), 다음 실행이 남은 건을 오래된 순으로 이어서 확정한다", async () => {
    const s = await shop();
    // 공급자에는 결제가 있고 조회가 느린(건당 60ms) 상황
    const provider = new FakeBillingProvider();
    const slow = { ...provider, charge: provider.charge.bind(provider), issueBillingKey: provider.issueBillingKey.bind(provider), name: provider.name, cancelPayment: provider.cancelPayment.bind(provider),
      getPayment: async (id: string) => { await new Promise((r) => setTimeout(r, 60)); return provider.getPayment(id); } };
    for (let i = 0; i < 5; i++) {
      provider.failNext = "timeout_after_charge";
      await chargeMessageBalance(db, provider, s.ctx, { amount: 1_000, idempotencyKey: `slow-${i}` });
    }
    await db.messageCharge.updateMany({ data: { createdAt: new Date(Date.now() - 5 * 60_000) } });
    const first = await reconcileMessageCharges(db, slow, { deadline: Date.now() + 100 });
    expect(first.truncated).toBe(true);
    expect(first.paid).toBeGreaterThanOrEqual(1);
    expect(first.paid).toBeLessThan(5);
    const rest = await reconcileMessageCharges(db, slow, { deadline: Date.now() + 10_000 });
    expect(rest).toMatchObject({ truncated: false, errors: 0 });
    expect(first.paid + rest.paid).toBe(5);
    expect(await paid(s.seller.id)).toBe(5_000);
    expect(provider.charges).toHaveLength(5);
  });

  it("예산을 다 쓰면 정리도 멈추고 아무것도 잃지 않는다(예산 0 → 0건, 다음 실행에서 처리)", async () => {
    const s = await shop();
    await db.subscriptionPlan.update({ where: { code: "INTEGRATED" }, data: { mailMonthlyQuota: 0 } });
    await db.messageChannelPrice.create({ data: { channel: "MAIL_TRANSACTIONAL", unitPrice: 10 } });
    await db.sellerMessageBalance.create({ data: { sellerId: s.seller.id, paidBalance: 30 } });
    const { reserveMail } = await import("../../lib/server/mail/quota");
    for (let i = 0; i < 3; i++) expect((await reserveMail(db, { sellerId: s.seller.id, kind: "t" })).ok).toBe(true);
    await db.mailDelivery.updateMany({ data: { createdAt: new Date(Date.now() - STALE_MAIL_HOLD_MS - 1000) } });
    expect(await expireStaleMessageHolds(db, { deadline: Date.now() - 1 })).toEqual({ mailsFailed: 0, debitsReleased: 0, truncated: true });
    expect(await runMessageJobs(db, new Date(), 0)).toBe(0);
    expect(await db.mailDelivery.count({ where: { status: "PENDING" } })).toBe(3);
    expect(await runMessageJobs(db, new Date())).toBe(3);
    expect(await db.mailDelivery.count({ where: { status: "FAILED" } })).toBe(3);
    expect(await paid(s.seller.id)).toBe(30);
  });
});
