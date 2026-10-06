import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { type MailSender, sendMail } from "../../lib/server/mail/quota";
import { settleMessageCharge } from "../../lib/server/messaging/charge";
import { MESSAGE_FEE_NOTICE_VERSION } from "../../lib/server/messaging/balance";
import { recordMessageShortage, resolveMessageShortages, shortageTitle } from "../../lib/server/messaging/shortage";
import { listSellerNotifications } from "../../lib/server/notifications/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createSeller, createSellerUser, db, resetDb } from "./helpers";

// 충전금 부족·충전 기능 꺼짐으로 건너뛴 일 → 파트너스 알림 센터 「충전금」 알림(같은 사유는 열린 기록 1개, 충전하면 해소)
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const msg = { to: "buyer@example.com", subject: "주문 안내", html: "<p>안내</p>" };
const okSender: MailSender = { async send() { return { providerMessageId: "m" }; } };
const send = (sellerId: string) => sendMail(db, okSender, { sellerId, kind: "order.paid", bulk: false, message: msg });

async function shop(quota = 0) {
  const { seller } = await createSeller();
  const plan = await db.subscriptionPlan.update({ where: { code: "INTEGRATED" }, data: { mailMonthlyQuota: quota } });
  await db.seller.update({ where: { id: seller.id }, data: { planId: plan.id } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, owner, ctx };
}
const charging = (enabled: boolean) => db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, chargingEnabled: enabled }, update: { chargingEnabled: enabled } });
const price = (channel: "MAIL_TRANSACTIONAL" | "DELIVERY_TRACKING", unitPrice: number) =>
  db.messageChannelPrice.upsert({ where: { channel }, create: { channel, unitPrice }, update: { unitPrice } });
const open = (sellerId: string) => db.messageShortage.findMany({ where: { sellerId, resolvedAt: null }, orderBy: { id: "asc" } });
const charge = async (s: { seller: { id: string }; owner: { id: string } }) => {
  const c = await db.messageCharge.create({ data: { sellerId: s.seller.id, sellerUserId: s.owner.id, amount: 1000, idempotencyKey: `k-${Math.random()}`, noticeVersion: MESSAGE_FEE_NOTICE_VERSION } });
  await settleMessageCharge(db, c.id, { ok: true, paymentId: "p-1", receiptUrl: null });
};

describe("충전금 부족 기록", () => {
  it("같은 판매자·채널·사유는 열린 기록 1개로 합치고, 같은 사건 키는 다시 세지 않는다. 동시에 불러도 한 행", async () => {
    const s = await shop();
    const t = new Date("2026-10-06T00:00:00Z");
    await recordMessageShortage(db, { sellerId: s.seller.id, channel: "MAIL_TRANSACTIONAL", reason: "INSUFFICIENT_BALANCE", eventKey: "a", now: t });
    await recordMessageShortage(db, { sellerId: s.seller.id, channel: "MAIL_TRANSACTIONAL", reason: "INSUFFICIENT_BALANCE", eventKey: "a", now: new Date(t.getTime() + 1000) });
    expect(await open(s.seller.id)).toEqual([expect.objectContaining({ count: 1, firstAt: t, lastAt: t })]);
    const t2 = new Date(t.getTime() + 60_000);
    await recordMessageShortage(db, { sellerId: s.seller.id, channel: "MAIL_TRANSACTIONAL", reason: "INSUFFICIENT_BALANCE", eventKey: "b", now: t2 });
    expect(await open(s.seller.id)).toEqual([expect.objectContaining({ count: 2, firstAt: t, lastAt: t2 })]);
    // 다른 사유·다른 채널은 따로
    await recordMessageShortage(db, { sellerId: s.seller.id, channel: "MAIL_TRANSACTIONAL", reason: "CHARGING_DISABLED", eventKey: "c" });
    await recordMessageShortage(db, { sellerId: s.seller.id, channel: "DELIVERY_TRACKING", reason: "INSUFFICIENT_BALANCE", eventKey: "d" });
    expect(await open(s.seller.id)).toHaveLength(3);
    await Promise.all(Array.from({ length: 8 }, (_, i) => recordMessageShortage(db, { sellerId: s.seller.id, channel: "SMS", reason: "INSUFFICIENT_BALANCE", eventKey: `p${i}` })));
    expect(await db.messageShortage.findMany({ where: { sellerId: s.seller.id, channel: "SMS", resolvedAt: null } })).toEqual([expect.objectContaining({ count: 8 })]);
  });

  it("해소는 범위(채널·사유)만 풀고, 풀린 뒤 다시 부족하면 새 열린 기록이 생긴다", async () => {
    const s = await shop();
    for (const channel of ["MAIL_TRANSACTIONAL", "DELIVERY_TRACKING"] as const) await recordMessageShortage(db, { sellerId: s.seller.id, channel, reason: "INSUFFICIENT_BALANCE", eventKey: channel });
    expect(await resolveMessageShortages(db, { sellerId: s.seller.id, channels: ["DELIVERY_TRACKING"] })).toBe(1);
    expect((await open(s.seller.id)).map((r) => r.channel)).toEqual(["MAIL_TRANSACTIONAL"]);
    expect(await resolveMessageShortages(db, { sellerId: s.seller.id, reasons: ["CHARGING_DISABLED"] })).toBe(0);
    await resolveMessageShortages(db, { sellerId: s.seller.id });
    await recordMessageShortage(db, { sellerId: s.seller.id, channel: "MAIL_TRANSACTIONAL", reason: "INSUFFICIENT_BALANCE", eventKey: "again" });
    expect(await open(s.seller.id)).toEqual([expect.objectContaining({ count: 1 })]);
    expect(await db.messageShortage.count({ where: { sellerId: s.seller.id } })).toBe(3);
  });

  it("문구는 합니다체이고 코드성 표기가 없다", () => {
    expect(shortageTitle("MAIL_TRANSACTIONAL", "INSUFFICIENT_BALANCE")).toBe("충전금이 부족해 메일 발송을 건너뛰었습니다");
    expect(shortageTitle("DELIVERY_TRACKING", "INSUFFICIENT_BALANCE")).toBe("충전금이 부족해 배송 자동조회를 건너뛰었습니다");
    expect(shortageTitle("MAIL_TRANSACTIONAL", "CHARGING_DISABLED")).toBe("지금은 충전금 기능을 쓸 수 없어 메일 발송을 건너뛰었습니다");
  });
});

describe("메일 발송을 건너뛰면 알림 센터에 한 줄", () => {
  it("잔액 부족 미발송 → 알림 1줄(여러 번 건너뛰어도 한 줄), 충전하면 사라지고 다시 부족하면 새로 쌓인다", async () => {
    const s = await shop(0);
    await charging(true);
    await price("MAIL_TRANSACTIONAL", 10);
    expect((await send(s.seller.id)).status).toBe("SKIPPED_BALANCE");
    expect((await send(s.seller.id)).status).toBe("SKIPPED_BALANCE");
    expect(await open(s.seller.id)).toEqual([expect.objectContaining({ channel: "MAIL_TRANSACTIONAL", reason: "INSUFFICIENT_BALANCE", count: 2 })]);
    const list = await listSellerNotifications(db, s.ctx);
    const items = list.items.filter((i) => i.kind === "CHARGE_SHORTAGE");
    expect(items).toEqual([expect.objectContaining({ title: "충전금이 부족해 메일 발송을 건너뛰었습니다", href: "/seller/settings/message-balance", unread: true })]);
    expect(items[0].id).toMatch(/^charge-shortage:/);
    // 충전하면 잔액 부족 알림이 풀린다
    await charge(s);
    expect((await listSellerNotifications(db, s.ctx)).items.filter((i) => i.kind === "CHARGE_SHORTAGE")).toEqual([]);
    expect(await open(s.seller.id)).toEqual([]);
    // 충전 금액(1,000원)을 다 써서 다시 모자라면 새로 쌓인다
    await db.sellerMessageBalance.update({ where: { sellerId: s.seller.id }, data: { paidBalance: 0 } });
    expect((await send(s.seller.id)).status).toBe("SKIPPED_BALANCE");
    expect(await open(s.seller.id)).toEqual([expect.objectContaining({ count: 1 })]);
  });

  it("충전 기능이 꺼져 있어 건너뛰면 다른 문구로 남고, 이후 차감이 성공하면 풀린다", async () => {
    const s = await shop(0);
    await charging(false);
    await price("MAIL_TRANSACTIONAL", 10);
    expect((await send(s.seller.id)).status).toBe("SKIPPED_BALANCE");
    const items = (await listSellerNotifications(db, s.ctx)).items.filter((i) => i.kind === "CHARGE_SHORTAGE");
    expect(items.map((i) => i.title)).toEqual(["지금은 충전금 기능을 쓸 수 없어 메일 발송을 건너뛰었습니다"]);
    // 충전 기능을 켜고 잔액이 있으면 다음 발송이 되고 알림은 풀린다
    await charging(true);
    await db.sellerMessageBalance.upsert({ where: { sellerId: s.seller.id }, create: { sellerId: s.seller.id, paidBalance: 100 }, update: { paidBalance: 100 } });
    expect((await send(s.seller.id)).status).toBe("SENT");
    expect(await open(s.seller.id)).toEqual([]);
  });

  it("충전금을 다루는 권한(SUBSCRIPTION_MANAGE)이 없는 직원과 다른 판매자에게는 보이지 않는다", async () => {
    const a = await shop(0);
    const b = await shop(0);
    await charging(true);
    await price("MAIL_TRANSACTIONAL", 10);
    await send(a.seller.id);
    const staff = await createSellerUser(a.seller.id, "BROADCASTER");
    const staffCtx: TenantContext = { ...a.ctx, actorId: staff.id, isOwner: false, permissions: ["ORDER_SHIPPING"] };
    expect((await listSellerNotifications(db, staffCtx)).items.filter((i) => i.kind === "CHARGE_SHORTAGE")).toEqual([]);
    expect((await listSellerNotifications(db, b.ctx)).items.filter((i) => i.kind === "CHARGE_SHORTAGE")).toEqual([]);
    expect((await listSellerNotifications(db, a.ctx)).items.filter((i) => i.kind === "CHARGE_SHORTAGE")).toHaveLength(1);
  });

  it("건너뛰지 않으면(제공량 안·잔액 충분) 기록이 없다", async () => {
    const s = await shop(5);
    await charging(true);
    await price("MAIL_TRANSACTIONAL", 10);
    expect((await send(s.seller.id)).status).toBe("SENT");
    expect(await open(s.seller.id)).toEqual([]);
  });
});
