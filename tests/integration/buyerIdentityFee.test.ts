import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as confirmRoute } from "../../app/api/shop/[slug]/signup/verification/confirm/route";
import { POST as startRoute } from "../../app/api/shop/[slug]/signup/verification/route";
import { prisma } from "../../lib/server/db";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { identityProvider } from "../../lib/server/identity/registry";
import { identityFeeKey } from "../../lib/server/identity/fee";
import { expireStaleMessageHolds, STALE_DEBIT_HOLD_MS } from "../../lib/server/messaging/holds";
import { IDV_INPUT, SIGNUP_CONSENT, createSeller, db, resetDb } from "./helpers";

// 구매자 가입 본인확인 건당 비용(대표님 확정 2026-10-26): 체험 밖 쇼핑몰은 파트너스 발송·이용 충전금에서 차감.
// 시작 때 잡고(PENDING) → 성공 확정 때 확정(SUCCEEDED) → 못 보내면 되돌림(REVERSED). 잔액이 없으면 가입 본인확인만 시작하지 않는다.
beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const PRICE = 70;
const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const post = (url: string, body: unknown, cookie?: string) => new Request(`http://localhost:3000${url}`, { method: "POST", headers: { ...H, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0];

// 구독 중(체험 아님) 쇼핑몰. balance가 있으면 유료 잔액으로 넣는다.
async function paidShop(opts: { balance?: number; price?: number; charging?: boolean } = {}) {
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: new Date("2000-01-01T00:00:00Z") } });
  const plan = await db.subscriptionPlan.upsert({
    where: { code: "INTEGRATED" },
    update: {},
    create: { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000 },
  });
  await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), nextChargeAt: new Date(Date.now() + 20 * 86_400_000) } });
  await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, chargingEnabled: opts.charging ?? true }, update: { chargingEnabled: opts.charging ?? true } });
  await db.messageChannelPrice.upsert({ where: { channel: "IDENTITY_VERIFICATION" }, create: { channel: "IDENTITY_VERIFICATION", unitPrice: opts.price ?? PRICE }, update: { unitPrice: opts.price ?? PRICE } });
  await db.sellerMessageBalance.upsert({ where: { sellerId: seller.id }, create: { sellerId: seller.id, paidBalance: opts.balance ?? 1000 }, update: { paidBalance: opts.balance ?? 1000 } });
  const base = `/api/shop/${seller.slug}/signup/verification`;
  const start = (extra: Record<string, unknown> = {}) => startRoute(post(base, { ...IDV_INPUT, ...SIGNUP_CONSENT, ...extra }), ctx(seller.slug));
  const confirm = (v: { cookie: string; verificationId: string }, code = "000000") => confirmRoute(post(`${base}/confirm`, { verificationId: v.verificationId, code }, v.cookie), ctx(seller.slug));
  const ledger = (verificationId: string) => db.sellerMessageLedger.findMany({ where: { sellerId: seller.id, idempotencyKey: identityFeeKey(verificationId) } });
  const balance = async () => (await db.sellerMessageBalance.findUniqueOrThrow({ where: { sellerId: seller.id } })).paidBalance;
  return { seller, start, confirm, ledger, balance };
}

describe("구매자 가입 본인확인 건당 비용", () => {
  it("체험 밖 쇼핑몰: 시작 때 차감을 잡고(PENDING), 본인확인이 성공하면 확정한다(SUCCEEDED, 단가만큼 잔액 감소)", async () => {
    const s = await paidShop();
    const r = await s.start();
    expect(r.status).toBe(200);
    const v = { cookie: cookieOf(r, "lo_bidv"), verificationId: (await r.json()).verificationId as string };
    expect(await s.ledger(v.verificationId)).toEqual([expect.objectContaining({ type: "DEBIT", status: "PENDING", channel: "IDENTITY_VERIFICATION", paidAmount: -PRICE, unitPrice: PRICE })]);
    expect(await s.balance()).toBe(1000 - PRICE);
    expect((await s.confirm(v)).status).toBe(200);
    expect(await s.ledger(v.verificationId)).toEqual([expect.objectContaining({ status: "SUCCEEDED" })]);
    expect(await s.balance()).toBe(1000 - PRICE);
  });

  it("인증번호를 틀려 확정되지 않으면 확정하지 않고, 멈춘 예약 정리(30분)가 되돌려 잔액이 그대로 돌아온다", async () => {
    const s = await paidShop();
    const r = await s.start();
    const v = { cookie: cookieOf(r, "lo_bidv"), verificationId: (await r.json()).verificationId as string };
    expect((await s.confirm(v, "111111")).status).toBe(400);
    expect(await s.ledger(v.verificationId)).toEqual([expect.objectContaining({ status: "PENDING" })]);
    const now = new Date(Date.now() + STALE_DEBIT_HOLD_MS + 60_000);
    expect(await expireStaleMessageHolds(db, { now })).toMatchObject({ debitsReleased: 1 });
    expect(await s.ledger(v.verificationId)).toEqual([expect.objectContaining({ status: "REVERSED" })]);
    expect(await s.balance()).toBe(1000);
  });

  it("같은 attemptKey로 다시 시작해도(응답 유실 재시도) 차감은 한 번만 잡는다", async () => {
    const s = await paidShop();
    const attemptKey = "5b3a1c7e-6d52-4c1f-9a9e-0b4f7e2d1a33";
    const a = await s.start({ attemptKey });
    const b = await s.start({ attemptKey });
    expect((await a.json()).verificationId).toBe((await b.json()).verificationId);
    expect(await db.sellerMessageLedger.count({ where: { sellerId: s.seller.id, channel: "IDENTITY_VERIFICATION" } })).toBe(1);
    expect(await s.balance()).toBe(1000 - PRICE);
  });

  it("인증번호를 보내지 못하면(공급자 장애) 잡아 둔 차감을 바로 되돌린다", async () => {
    const s = await paidShop();
    (identityProvider() as FakeIdentityProvider).failNext("error");
    const r = await s.start();
    expect(r.status).toBe(502);
    const rows = await db.sellerMessageLedger.findMany({ where: { sellerId: s.seller.id, channel: "IDENTITY_VERIFICATION" } });
    expect(rows).toEqual([expect.objectContaining({ status: "REVERSED" })]);
    expect(await s.balance()).toBe(1000);
  });

  it("잔액이 단가보다 적으면 가입 본인확인만 시작하지 않는다: 403 trial_limit_exceeded 안내, 문자·요청 기록·차감 없음, 알림 센터 「충전금」 부족 알림이 남는다", async () => {
    const s = await paidShop({ balance: PRICE - 1 });
    const fake = identityProvider() as FakeIdentityProvider;
    const sentBefore = fake.sent.length;
    const r = await s.start();
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: "trial_limit_exceeded", message: "지금은 가입할 수 없어요. 쇼핑몰에 문의해 주세요" });
    expect(fake.sent.length).toBe(sentBefore);
    expect(await db.identityVerification.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect(await db.sellerMessageLedger.count({ where: { sellerId: s.seller.id, channel: "IDENTITY_VERIFICATION" } })).toBe(0);
    expect(await s.balance()).toBe(PRICE - 1);
    expect(await db.messageShortage.findMany({ where: { sellerId: s.seller.id, channel: "IDENTITY_VERIFICATION", resolvedAt: null } })).toEqual([expect.objectContaining({ reason: "INSUFFICIENT_BALANCE", count: 1 })]);
  });

  it("충전해서 잔액이 생기면 다시 시작할 수 있고 부족 알림이 풀린다", async () => {
    const s = await paidShop({ balance: 0 });
    expect((await s.start()).status).toBe(403);
    await db.sellerMessageBalance.update({ where: { sellerId: s.seller.id }, data: { paidBalance: 500 } });
    expect((await s.start()).status).toBe(200);
    expect(await db.messageShortage.count({ where: { sellerId: s.seller.id, channel: "IDENTITY_VERIFICATION", resolvedAt: null } })).toBe(0);
  });

  it("충전 기능이 꺼져 있으면(마스터 설정) 단가가 있어도 시작하지 않고 「충전 꺼짐」 알림을 남긴다", async () => {
    const s = await paidShop({ charging: false });
    expect((await s.start()).status).toBe(403);
    expect(await db.messageShortage.findMany({ where: { sellerId: s.seller.id, channel: "IDENTITY_VERIFICATION", resolvedAt: null } })).toEqual([expect.objectContaining({ reason: "CHARGING_DISABLED" })]);
  });

  it("단가가 0(대행사 계약 전 미설정)이면 차감 없이 그대로 시작하고, 충전 기능이 꺼져 있고 잔액이 0이어도 막지 않는다", async () => {
    const s = await paidShop({ price: 0, balance: 0, charging: false });
    const r = await s.start();
    expect(r.status).toBe(200);
    expect((await s.confirm({ cookie: cookieOf(r, "lo_bidv"), verificationId: (await r.json()).verificationId })).status).toBe(200);
    expect(await db.sellerMessageLedger.count({ where: { sellerId: s.seller.id } })).toBe(0);
  });

  it("체험 중인 쇼핑몰은 차감하지 않는다(단가가 있고 잔액이 0이어도 시작·확정된다)", async () => {
    const { seller } = await createSeller();
    await db.messageChannelPrice.upsert({ where: { channel: "IDENTITY_VERIFICATION" }, create: { channel: "IDENTITY_VERIFICATION", unitPrice: PRICE }, update: { unitPrice: PRICE } });
    await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, chargingEnabled: true }, update: { chargingEnabled: true } });
    const base = `/api/shop/${seller.slug}/signup/verification`;
    const r = await startRoute(post(base, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(seller.slug));
    expect(r.status).toBe(200);
    const verificationId = (await r.json()).verificationId as string;
    expect((await confirmRoute(post(`${base}/confirm`, { verificationId, code: "000000" }, cookieOf(r, "lo_bidv")), ctx(seller.slug))).status).toBe(200);
    expect(await db.sellerMessageLedger.count({ where: { sellerId: seller.id } })).toBe(0);
  });
});
