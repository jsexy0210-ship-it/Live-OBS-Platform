import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as adminSettingsGet, PUT as adminSettingsPut } from "../../app/api/admin/message-settings/route";
import { POST as pricePost } from "../../app/api/admin/message-prices/[channel]/route";
import { POST as planQuotaPost } from "../../app/api/admin/plans/[code]/mail-quota/route";
import { GET as adminBalanceGet, POST as grantPost } from "../../app/api/admin/sellers/[sellerId]/message-balance/route";
import { POST as consentPost } from "../../app/api/seller/message-balance/consent/route";
import { GET as ledgerGet } from "../../app/api/seller/message-balance/ledger/route";
import { GET as balanceGet, PUT as balancePut } from "../../app/api/seller/message-balance/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { type MailSender, reserveMail, sellerMailUsage, sendMail } from "../../lib/server/mail/quota";
import { MESSAGE_FEE_NOTICE_VERSION, captureDebit, releaseDebit, reserveDebit } from "../../lib/server/messaging/balance";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 메일 제공량·발송 충전 잔액·플랫폼 무료 한도(대표님 결정 2026-10-05, docs/terms/SELLER_MESSAGE_FEE_NOTICE.md)
beforeEach(resetDb);
// 차감 시험은 충전 기능이 켜진 상태에서 한다(꺼진 동안은 차감하지 않음: messageCharge.test.ts)
beforeEach(() => db.platformMessageSetting.create({ data: { id: 1, chargingEnabled: true } }));
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const msg = { to: "buyer@example.com", subject: "주문 안내", html: "<p>안내</p>" };

// 보낸 통을 세는 가짜 공급자(실제 발송 없음)
function fakeSender(opts: { delayMs?: number; fail?: boolean } = {}) {
  const keys: string[] = [];
  const sender: MailSender = {
    async send(_m, { idempotencyKey }) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error("provider down");
      keys.push(idempotencyKey);
      return { providerMessageId: `msg-${keys.length}` };
    },
  };
  return { sender, keys };
}

async function shop(quota: number) {
  const { seller } = await createSeller();
  const plan = await db.subscriptionPlan.update({ where: { code: "INTEGRATED" }, data: { mailMonthlyQuota: quota } });
  await db.seller.update({ where: { id: seller.id }, data: { planId: plan.id } });
  const owner = await createSellerUser(seller.id, "OWNER");
  return { seller, owner };
}
const setBalance = (sellerId: string, paidBalance: number, freeBalance: number) =>
  db.sellerMessageBalance.upsert({ where: { sellerId }, create: { sellerId, paidBalance, freeBalance }, update: { paidBalance, freeBalance } });
const balance = async (sellerId: string) => {
  const b = await db.sellerMessageBalance.findUnique({ where: { sellerId } });
  return [b?.paidBalance ?? 0, b?.freeBalance ?? 0];
};
const price = (channel: "MAIL_TRANSACTIONAL" | "MAIL_BULK" | "SMS" | "ALIMTALK", unitPrice: number) =>
  db.messageChannelPrice.upsert({ where: { channel }, create: { channel, unitPrice }, update: { unitPrice } });

async function sellerCookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function adminCookie(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}

const send = (sellerId: string | null, sender: MailSender, bulk = false) => sendMail(db, sender, { sellerId, kind: "order.paid", bulk, message: msg });

describe("거래 메일 제공량과 잔액 차감", () => {
  it("제공량까지 무료로 보내고, 넘으면 잔액에서 단가만큼 차감한다. 잔액이 모자라면 공급자를 부르지 않고 「잔액 부족 미발송」", async () => {
    const s = await shop(2);
    await price("MAIL_TRANSACTIONAL", 10);
    const f = fakeSender();
    expect((await send(s.seller.id, f.sender)).status).toBe("SENT");
    expect((await send(s.seller.id, f.sender)).status).toBe("SENT");
    expect(await send(s.seller.id, f.sender)).toMatchObject({ status: "SKIPPED_BALANCE", charged: true });
    expect(f.keys).toHaveLength(2);
    await setBalance(s.seller.id, 0, 25);
    expect(await send(s.seller.id, f.sender)).toMatchObject({ status: "SENT", charged: true });
    expect(await send(s.seller.id, f.sender)).toMatchObject({ status: "SENT", charged: true });
    expect((await send(s.seller.id, f.sender)).status).toBe("SKIPPED_BALANCE");
    expect(await balance(s.seller.id)).toEqual([0, 5]);
    const debits = await db.sellerMessageLedger.findMany({ where: { sellerId: s.seller.id, type: "DEBIT" } });
    expect(debits.map((d) => [d.status, d.channel, d.paidAmount, d.freeAmount, d.unitPrice])).toEqual([
      ["SUCCEEDED", "MAIL_TRANSACTIONAL", 0, -10, 10],
      ["SUCCEEDED", "MAIL_TRANSACTIONAL", 0, -10, 10],
    ]);
    // 발송 기록 id를 공급자 멱등키로, 차감 키는 그 발송 기록
    const sent = await db.mailDelivery.findMany({ where: { sellerId: s.seller.id, status: "SENT" } });
    expect(sent.map((d) => d.id).sort()).toEqual([...f.keys].sort());
    expect(sent.filter((d) => d.ledgerId)).toHaveLength(2);
    expect(await sellerMailUsage(db, s.seller.id)).toMatchObject({ quota: 2, sent: 4, freeSent: 2, chargedSent: 2, skippedBalance: 2 });
  });

  it("유료 잔액을 먼저 쓰고, 모자라면 무상 잔액에서 나머지를 뺀다(서식 4-2)", async () => {
    const s = await shop(0);
    await price("MAIL_TRANSACTIONAL", 10);
    await setBalance(s.seller.id, 15, 100);
    const f = fakeSender();
    await send(s.seller.id, f.sender);
    await send(s.seller.id, f.sender);
    expect(await balance(s.seller.id)).toEqual([0, 95]);
    const debits = await db.sellerMessageLedger.findMany({ where: { sellerId: s.seller.id }, orderBy: { createdAt: "asc" } });
    expect(debits.map((d) => [d.paidAmount, d.freeAmount])).toEqual([
      [-10, 0],
      [-5, -5],
    ]);
  });

  it("보내지 못하면 차감을 되돌리고(유료·무상 각각 원래대로) 제공량 셈에서도 빠진다", async () => {
    const s = await shop(0);
    await price("MAIL_TRANSACTIONAL", 10);
    await setBalance(s.seller.id, 5, 5);
    expect((await send(s.seller.id, fakeSender({ fail: true }).sender)).status).toBe("FAILED");
    expect(await balance(s.seller.id)).toEqual([5, 5]);
    expect((await db.sellerMessageLedger.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id } })).status).toBe("REVERSED");
    expect((await send(s.seller.id, fakeSender().sender)).status).toBe("SENT");
    expect(await balance(s.seller.id)).toEqual([0, 0]);
    expect(await sellerMailUsage(db, s.seller.id)).toMatchObject({ sent: 1, failed: 1 });
  });

  it("광고·공지 대량 메일은 제공량이 남아도 대량 메일 단가로 차감하고, 거래 메일 제공량을 쓰지 않는다", async () => {
    const s = await shop(5);
    await price("MAIL_BULK", 3);
    await setBalance(s.seller.id, 10, 0);
    const f = fakeSender();
    expect(await send(s.seller.id, f.sender, true)).toMatchObject({ status: "SENT", charged: true });
    expect(await balance(s.seller.id)).toEqual([7, 0]);
    expect((await db.sellerMessageLedger.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id } })).channel).toBe("MAIL_BULK");
    expect(await send(s.seller.id, f.sender)).toMatchObject({ status: "SENT", charged: false });
    expect(await sellerMailUsage(db, s.seller.id)).toMatchObject({ freeSent: 1, chargedSent: 1 });
  });

  it("단가 기본 0원이면 제공량을 넘어도 0원 차감 기록으로 보낸다", async () => {
    const s = await shop(0);
    expect(await send(s.seller.id, fakeSender().sender)).toMatchObject({ status: "SENT", charged: true });
    expect(await db.sellerMessageLedger.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id } })).toMatchObject({ status: "SUCCEEDED", paidAmount: 0, freeAmount: 0, unitPrice: 0 });
  });

  it("달은 KST 기준이다: 10월 31일 23:59 KST까지는 10월, 11월 1일 0시 KST부터 새 제공량", async () => {
    const s = await shop(1);
    await price("MAIL_TRANSACTIONAL", 10);
    const r1 = await reserveMail(db, { sellerId: s.seller.id, kind: "t", now: new Date("2026-10-31T14:59:00Z") });
    const r2 = await reserveMail(db, { sellerId: s.seller.id, kind: "t", now: new Date("2026-10-31T14:59:30Z") });
    const r3 = await reserveMail(db, { sellerId: s.seller.id, kind: "t", now: new Date("2026-10-31T15:00:00Z") });
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, false, true]);
    expect((await db.mailDelivery.findMany({ where: { sellerId: s.seller.id }, orderBy: { createdAt: "asc" } })).map((d) => d.month)).toEqual(["2026-10", "2026-10", "2026-11"]);
  });

  it("동시성: 제공량 3·잔액 20원·단가 10원에 12통을 한꺼번에 보내도 5통만 보내고 잔액은 0원(음수 없음)", async () => {
    const s = await shop(3);
    await price("MAIL_TRANSACTIONAL", 10);
    await setBalance(s.seller.id, 20, 0);
    const f = fakeSender({ delayMs: 30 });
    const results = await Promise.all(Array.from({ length: 12 }, () => send(s.seller.id, f.sender)));
    expect(results.filter((r) => r.status === "SENT")).toHaveLength(5);
    expect(results.filter((r) => r.status === "SKIPPED_BALANCE")).toHaveLength(7);
    expect(f.keys).toHaveLength(5);
    expect(await balance(s.seller.id)).toEqual([0, 0]);
    expect(await sellerMailUsage(db, s.seller.id)).toMatchObject({ sent: 5, freeSent: 3, chargedSent: 2, pending: 0 });
  });
});

describe("차감 원장(문자·알림톡·본인인증 등 공용)", () => {
  const debit = (sellerId: string, channel: "SMS" | "ALIMTALK", key: string) => db.$transaction((tx) => reserveDebit(tx, { sellerId, channel, idempotencyKey: key }));

  it("같은 요청 키는 한 번만 차감하고, 알림톡 실패 뒤 같은 키로 문자를 잡으면 최종 성공 채널 한 건만 남는다", async () => {
    const s = await shop(0);
    await price("ALIMTALK", 8);
    await price("SMS", 20);
    await setBalance(s.seller.id, 100, 0);
    const a = await debit(s.seller.id, "ALIMTALK", "notice:order-1");
    const again = await debit(s.seller.id, "ALIMTALK", "notice:order-1");
    expect(a).toMatchObject({ ok: true, existing: false, amount: 8 });
    expect(again).toMatchObject({ ok: true, existing: true, amount: 8 });
    if (!a.ok) throw new Error();
    expect(await balance(s.seller.id)).toEqual([92, 0]);
    // 알림톡 실패 → 되돌리고 문자로
    expect(await releaseDebit(db, a.ledgerId)).toBe(true);
    const sms = await debit(s.seller.id, "SMS", "notice:order-1");
    if (!sms.ok) throw new Error();
    expect(await captureDebit(db, sms.ledgerId)).toBe(true);
    // 확정된 차감은 되돌리지 않고, 되돌린 차감은 확정하지 않는다
    expect(await releaseDebit(db, sms.ledgerId)).toBe(false);
    expect(await captureDebit(db, a.ledgerId)).toBe(false);
    expect(await balance(s.seller.id)).toEqual([80, 0]);
    const rows = await db.sellerMessageLedger.findMany({ where: { sellerId: s.seller.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.channel, r.status, r.paidAmount])).toEqual([
      ["ALIMTALK", "REVERSED", -8],
      ["SMS", "SUCCEEDED", -20],
    ]);
  });

  it("동시성: 같은 키 8번을 한꺼번에 보내도 한 번만 차감한다. 다른 키 8번은 남은 잔액(15원, 10원씩)만큼 1번만", async () => {
    const s = await shop(0);
    await price("SMS", 10);
    await setBalance(s.seller.id, 25, 0);
    const same = await Promise.all(Array.from({ length: 8 }, () => debit(s.seller.id, "SMS", "same")));
    expect(same.filter((r) => r.ok && !r.existing)).toHaveLength(1);
    expect(await balance(s.seller.id)).toEqual([15, 0]);
    const many = await Promise.all(Array.from({ length: 8 }, (_, i) => debit(s.seller.id, "SMS", `k${i}`)));
    expect(many.filter((r) => r.ok)).toHaveLength(1);
    expect(many.filter((r) => !r.ok)).toHaveLength(7);
    expect(await balance(s.seller.id)).toEqual([5, 0]);
  });

  it("잔액은 DB에서도 음수가 될 수 없다", async () => {
    const s = await shop(0);
    await setBalance(s.seller.id, 1, 0);
    await expect(db.sellerMessageBalance.update({ where: { sellerId: s.seller.id }, data: { paidBalance: { decrement: 2 } } })).rejects.toThrow();
  });
});

describe("플랫폼 전체 무료 한도", () => {
  it("하루 한도에 이르면 누구의 메일도 보내지 않고(차감도 안 함), 80%·다 씀을 하루에 한 번씩 로그 추적에 남긴다", async () => {
    await db.platformMessageSetting.update({ where: { id: 1 }, data: { platformDailyLimit: 5, platformMonthlyLimit: 3000 } });
    const a = await shop(100);
    const b = await shop(100);
    const f = fakeSender();
    const order = [a.seller.id, b.seller.id, null, a.seller.id, b.seller.id, a.seller.id, null];
    const results = [];
    for (const id of order) results.push((await send(id, f.sender)).status);
    expect(results).toEqual(["SENT", "SENT", "SENT", "SENT", "SENT", "SKIPPED_PLATFORM_LIMIT", "SKIPPED_PLATFORM_LIMIT"]);
    expect(f.keys).toHaveLength(5);
    const near = await db.auditLog.findMany({ where: { action: "mail.platform_near_limit" } });
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ actorType: "SYSTEM", targetType: "MailPlatform", after: { used: 4, limit: 5 } });
    expect(near[0].targetId).toMatch(/^day:\d{4}-\d{2}-\d{2}$/);
    expect(await db.auditLog.count({ where: { action: "mail.platform_limit_reached" } })).toBe(1);
    expect(await sellerMailUsage(db, a.seller.id)).toMatchObject({ sent: 2, skippedPlatformLimit: 1, skippedBalance: 0 });
    expect(await db.sellerMessageLedger.count()).toBe(0);
  });

  it("동시성: 하루 한도 4에 여러 파트너스가 한꺼번에 10통을 보내도 4통만 보낸다", async () => {
    await db.platformMessageSetting.update({ where: { id: 1 }, data: { platformDailyLimit: 4 } });
    const shops = await Promise.all([shop(100), shop(100)]);
    const f = fakeSender({ delayMs: 20 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => send(shops[i % 2].seller.id, f.sender)));
    expect(results.filter((r) => r.status === "SENT")).toHaveLength(4);
    expect(f.keys).toHaveLength(4);
  });
});

describe("파트너스 발송 충전 API", () => {
  const get = (cookie: string) => balanceGet(new Request("http://localhost:3000/api/seller/message-balance", { headers: { ...H, cookie } }));
  const put = (cookie: string, body: unknown) =>
    balancePut(new Request("http://localhost:3000/api/seller/message-balance", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  const consent = (cookie: string, body: unknown) =>
    consentPost(new Request("http://localhost:3000/api/seller/message-balance/consent", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  const ledger = (cookie: string, q = "") => ledgerGet(new Request(`http://localhost:3000/api/seller/message-balance/ledger${q}`, { headers: { ...H, cookie } }));

  it("대표자가 잔액·단가·이번 달 메일·동의를 보고, 잔액 부족 알림 기준을 정하고, 비용 안내에 동의한다. 직원 403, 정지 중엔 보기만", async () => {
    const s = await shop(50);
    await price("SMS", 20);
    await setBalance(s.seller.id, 30, 10);
    const cookie = await sellerCookie(s.owner.email);
    const g = await get(cookie);
    expect(g.status).toBe(200);
    const view = await g.json();
    expect(view).toMatchObject({ paidBalance: 30, freeBalance: 10, total: 40, lowBalanceThreshold: 0, lowBalance: false, chargingEnabled: true, noticeVersion: MESSAGE_FEE_NOTICE_VERSION, consent: null, mail: { quota: 50, sent: 0 } });
    expect(view.prices).toHaveLength(7);
    expect(view.prices).toEqual(expect.arrayContaining([{ channel: "SMS", unitPrice: 20, next: null }, { channel: "IDENTITY_VERIFICATION", unitPrice: 0, next: null }]));

    const t = await put(cookie, { lowBalanceThreshold: 50 });
    expect(t.status).toBe(200);
    expect(await t.json()).toMatchObject({ lowBalanceThreshold: 50, lowBalance: true });
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "seller.message_balance.threshold_update" } })).toMatchObject({ actorId: s.owner.id, before: { lowBalanceThreshold: 0 }, after: { lowBalanceThreshold: 50 } });
    for (const body of [{}, { lowBalanceThreshold: -1 }, { lowBalanceThreshold: "5" }, { lowBalanceThreshold: 10_000_001 }]) expect((await put(cookie, body)).status).toBe(400);

    const bad = await consent(cookie, { version: "old" });
    expect(bad.status).toBe(409);
    expect(await bad.json()).toMatchObject({ error: "notice_version_mismatch" });
    const ok = await consent(cookie, { version: MESSAGE_FEE_NOTICE_VERSION });
    expect(ok.status).toBe(200);
    const c1 = await ok.json();
    expect(c1).toMatchObject({ version: MESSAGE_FEE_NOTICE_VERSION, sellerUserId: s.owner.id, consentedAt: expect.any(String) });
    expect(await (await consent(cookie, { version: MESSAGE_FEE_NOTICE_VERSION })).json()).toEqual(c1);
    expect(await db.sellerMessageFeeConsent.count({ where: { sellerId: s.seller.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "seller.message_fee.consent" } })).toBe(1);

    const staff = await createSellerUser(s.seller.id, { permissions: ["SHOP_SETTINGS"] });
    const staffCookie = await sellerCookie(staff.email);
    expect((await get(staffCookie)).status).toBe(403);
    expect((await put(staffCookie, { lowBalanceThreshold: 1 })).status).toBe(403);
    expect((await consent(staffCookie, { version: MESSAGE_FEE_NOTICE_VERSION })).status).toBe(403);
    expect((await ledger(staffCookie)).status).toBe(403);

    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await get(cookie)).status).toBe(200);
    expect((await ledger(cookie)).status).toBe(200);
    expect((await put(cookie, { lowBalanceThreshold: 1 })).status).toBe(403);
  });

  it("사용 내역: 최근 순 커서, 다른 파트너스 내역은 보이지 않는다", async () => {
    const s = await shop(0);
    const other = await shop(0);
    await price("SMS", 1);
    await setBalance(s.seller.id, 10, 0);
    await setBalance(other.seller.id, 10, 0);
    for (let i = 0; i < 3; i++) await db.$transaction((tx) => reserveDebit(tx, { sellerId: s.seller.id, channel: "SMS", idempotencyKey: `k${i}` }));
    await db.$transaction((tx) => reserveDebit(tx, { sellerId: other.seller.id, channel: "SMS", idempotencyKey: "x" }));
    const cookie = await sellerCookie(s.owner.email);
    const p1 = await (await ledger(cookie, "?limit=2")).json();
    expect(p1.entries).toHaveLength(2);
    expect(p1.entries[0]).toMatchObject({ type: "DEBIT", status: "PENDING", channel: "SMS", paidAmount: -1, freeAmount: 0 });
    expect(p1.entries[0]).not.toHaveProperty("idempotencyKey");
    const p2 = await (await ledger(cookie, `?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`)).json();
    expect(p2.entries).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    expect((await ledger(cookie, "?cursor=bad")).status).toBe(400);
  });
});

describe("마스터 관리자 발송 설정 API", () => {
  const get = (cookie: string) => adminSettingsGet(new Request("http://localhost:3000/api/admin/message-settings", { headers: { ...H, cookie } }));
  const put = (cookie: string, body: unknown) =>
    adminSettingsPut(new Request("http://localhost:3000/api/admin/message-settings", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  const setPrice = (cookie: string, channel: string, body: unknown) =>
    pricePost(new Request(`http://localhost:3000/api/admin/message-prices/${channel}`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ channel }) });
  const quota = (cookie: string, code: string, body: unknown) =>
    planQuotaPost(new Request(`http://localhost:3000/api/admin/plans/${code}/mail-quota`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ code }) });
  const grant = (cookie: string, sellerId: string, body: unknown) =>
    grantPost(new Request(`http://localhost:3000/api/admin/sellers/${sellerId}/message-balance`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }), { params: Promise.resolve({ sellerId }) });
  const sellerBalance = (cookie: string, sellerId: string) =>
    adminBalanceGet(new Request(`http://localhost:3000/api/admin/sellers/${sellerId}/message-balance`, { headers: { ...H, cookie } }), { params: Promise.resolve({ sellerId }) });

  it("보기는 모든 역할, 충전 스위치·플랫폼 한도 변경은 최고관리자만(로그 추적). 파트너스 세션은 401", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const ro = await adminCookie("READ_ONLY");
    const ops = await adminCookie("OPERATIONS");
    const view = await (await get(ro.cookie)).json();
    expect(view).toMatchObject({ chargingEnabled: true, platformDailyLimit: 100, platformMonthlyLimit: 3000, usage: { today: { used: 0, limit: 100 }, thisMonth: { used: 0, limit: 3000 } } });
    expect(view.plans).toEqual(expect.arrayContaining([{ code: "INTEGRATED", name: "쇼핑몰 통합", mailMonthlyQuota: 100, next: null }]));
    expect(view.prices).toHaveLength(7);

    expect((await put(ops.cookie, { chargingEnabled: true })).status).toBe(403);
    expect((await put(ro.cookie, { platformDailyLimit: 10 })).status).toBe(403);
    const ok = await put(su.cookie, { platformDailyLimit: 90 });
    expect(await ok.json()).toMatchObject({ chargingEnabled: true, platformDailyLimit: 90 });
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "admin.message_settings.update" } })).toMatchObject({ actorId: su.id, before: { platformDailyLimit: 100 }, after: { platformDailyLimit: 90 } });
    for (const body of [{}, { chargingEnabled: "true" }, { platformDailyLimit: -1 }]) expect((await put(su.cookie, body)).status).toBe(400);

    const s = await shop(1);
    expect((await get(await sellerCookie(s.owner.email))).status).toBe(401);
  });

  it("단가·제공량: 최고관리자만, 적용 예정일을 두면 그때까지는 지금 값, 지난 뒤 차감·판정에 새 값(로그 추적)", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const ops = await adminCookie("OPERATIONS");
    expect((await setPrice(ops.cookie, "SMS", { unitPrice: 10 })).status).toBe(403);
    expect((await setPrice(su.cookie, "FAX", { unitPrice: 10 })).status).toBe(404);
    for (const body of [{}, { unitPrice: -1 }, { unitPrice: 1.5 }, { unitPrice: 100_001 }, { unitPrice: 1, effectiveAt: "내일" }]) expect((await setPrice(su.cookie, "SMS", body)).status).toBe(400);
    expect(await (await setPrice(su.cookie, "SMS", { unitPrice: 10 })).json()).toEqual({ channel: "SMS", unitPrice: 10, next: null });
    const later = new Date(Date.now() + 7 * 86_400_000);
    const p = await (await setPrice(su.cookie, "SMS", { unitPrice: 15, effectiveAt: later.toISOString() })).json();
    expect(p).toEqual({ channel: "SMS", unitPrice: 10, next: { unitPrice: 15, effectiveAt: later.toISOString() } });
    expect(await db.auditLog.count({ where: { action: "admin.message_price.update", targetId: "SMS" } })).toBe(2);

    const s = await shop(0);
    await setBalance(s.seller.id, 100, 0);
    const now = await db.$transaction((tx) => reserveDebit(tx, { sellerId: s.seller.id, channel: "SMS", idempotencyKey: "a" }));
    const after = await db.$transaction((tx) => reserveDebit(tx, { sellerId: s.seller.id, channel: "SMS", idempotencyKey: "b", now: new Date(later.getTime() + 1000) }));
    expect([now.amount, after.amount]).toEqual([10, 15]);

    expect((await quota(ops.cookie, "INTEGRATED", { monthlyQuota: 500 })).status).toBe(403);
    expect((await quota(su.cookie, "NOPE", { monthlyQuota: 1 })).status).toBe(404);
    expect((await quota(su.cookie, "INTEGRATED", { monthlyQuota: -1 })).status).toBe(400);
    expect(await (await quota(su.cookie, "INTEGRATED", { monthlyQuota: 300 })).json()).toEqual({ code: "INTEGRATED", mailMonthlyQuota: 300, next: null });
    const q = await (await quota(su.cookie, "INTEGRATED", { monthlyQuota: 200, effectiveAt: later.toISOString() })).json();
    expect(q).toEqual({ code: "INTEGRATED", mailMonthlyQuota: 300, next: { mailMonthlyQuota: 200, effectiveAt: later.toISOString() } });
    expect((await sellerMailUsage(db, s.seller.id)).quota).toBe(300);
    expect((await sellerMailUsage(db, s.seller.id, new Date(later.getTime() + 1000))).quota).toBe(200);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "admin.plan.mail_quota_update" }, orderBy: { createdAt: "desc" } })).toMatchObject({
      actorId: su.id,
      before: { mailMonthlyQuota: 300 },
      after: { mailMonthlyQuota: 200, effectiveAt: later.toISOString() },
    });
  });

  it("무상 지급: 최고관리자만, 같은 요청 키는 한 번만(201 → 200), 잔액 조회는 platform.read", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const ops = await adminCookie("OPERATIONS");
    const ro = await adminCookie("READ_ONLY");
    const s = await shop(0);
    const body = { amount: 5000, reason: "출시 이벤트", idempotencyKey: "event-2026-10" };
    expect((await grant(ops.cookie, s.seller.id, body)).status).toBe(403);
    const r1 = await grant(su.cookie, s.seller.id, body);
    expect(r1.status).toBe(201);
    expect(await r1.json()).toMatchObject({ existing: false, balance: { paidBalance: 0, freeBalance: 5000 } });
    const r2 = await grant(su.cookie, s.seller.id, body);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ existing: true, balance: { freeBalance: 5000 } });
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "admin.message_balance.grant" } })).toMatchObject({ actorId: su.id, sellerId: s.seller.id, reason: "출시 이벤트", after: { freeAmount: 5000 } });
    for (const b of [{ ...body, amount: 0 }, { ...body, reason: "" }, { ...body, idempotencyKey: "" }, { ...body, amount: 10_000_001 }]) expect((await grant(su.cookie, s.seller.id, b)).status).toBe(400);
    expect((await grant(su.cookie, "00000000-0000-4000-8000-000000000000", body)).status).toBe(404);
    const v = await sellerBalance(ro.cookie, s.seller.id);
    expect(v.status).toBe(200);
    expect(await v.json()).toMatchObject({ paidBalance: 0, freeBalance: 5000, mail: { quota: 0 } });
    expect((await sellerBalance(ro.cookie, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});
