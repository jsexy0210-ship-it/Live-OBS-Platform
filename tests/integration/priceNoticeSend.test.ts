import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as sendRoute } from "../../app/api/admin/plans/[code]/price-notice/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { DEFAULT_PRICE_NOTICE_BEARER, PRICE_NOTICE_MAIL_KIND, sendPriceChangeNotices } from "../../lib/server/billing/priceNoticeSend";
import { chargeFor, dbNow } from "../../lib/server/billing/subscription";
import { FakeMailSender } from "../../lib/server/mail/registry";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 요금 변경 고지 발송 작업: 메일(대표자 1통)+파트너스 공지(변경마다 1건) → 수령 기록 → 두 채널 SENT면 고지 완료(30일 뒤 새 요금).
const DAY = 86_400_000;
beforeEach(resetDb);
beforeAll(() => {
  process.env.APP_ORIGIN = "https://onq.example.com";
});
afterAll(() => db.$disconnect());

async function fixture(opts: { subscribers?: number } = {}) {
  const now = await dbNow(db);
  const admin = await createAdmin("SUPER_ADMIN");
  const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } });
  await db.subscriptionPriceChange.create({ data: { planId: plan.id, listPrice: plan.listPrice, salePrice: plan.salePrice, changedAt: new Date("2000-01-01") } });
  const change = await db.subscriptionPriceChange.create({ data: { planId: plan.id, listPrice: 350000, salePrice: 249000, changedAt: new Date(+now - 2 * DAY), changedByAdminId: admin.id } });
  await db.subscriptionPlan.update({ where: { id: plan.id }, data: { listPrice: 350000, salePrice: 249000 } });
  const subs = [];
  for (let i = 0; i < (opts.subscribers ?? 1); i++) {
    const { seller } = await createSeller();
    await createSellerUser(seller.id, "OWNER", `owner${i}@example.com`);
    const sub = await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id, subscribedAt: new Date(+now - 90 * DAY) } });
    subs.push({ seller, sub });
  }
  return { now, admin, plan: await db.subscriptionPlan.findUniqueOrThrow({ where: { id: plan.id } }), change, subs };
}

describe("요금 변경 고지 발송 작업", () => {
  it("대상 구독마다 메일 1통·파트너스 공지 1건을 보내 수령 기록을 남기고, 두 채널이 끝나야 30일 뒤 새 요금이 적용된다", async () => {
    const f = await fixture({ subscribers: 2 });
    const sender = new FakeMailSender();
    const before = await chargeFor(db, f.plan, f.subs[0]!.sub, f.now);
    expect(before.amount).toBe(199000);
    const r = await sendPriceChangeNotices(db, { sender, now: f.now });
    expect(r).toMatchObject({ considered: 2, mailSent: 2, mailBlocked: 0, noticeCreated: 1, completed: 2 });
    expect(sender.sent.map((m) => m.to).sort()).toEqual(["owner0@example.com", "owner1@example.com"]);
    expect(sender.sent[0]?.subject).toContain("구독 요금이 바뀌어요");
    // 파트너스 공지는 변경마다 1건(대상 파트너스·정책 분류), 모든 구독의 수령 기록이 같은 공지를 가리킨다
    const notices = await db.platformNotice.findMany();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ audience: "PARTNERS", category: "POLICY", createdByAdminId: f.admin.id });
    expect(notices[0]?.publishedAt).not.toBeNull();
    const receipts = await db.subscriptionPriceNotice.findMany({ orderBy: [{ subscriptionId: "asc" }, { channel: "asc" }] });
    expect(receipts).toHaveLength(4);
    expect(receipts.every((x) => x.status === "SENT" && x.completedAt && x.deliveryReference)).toBe(true);
    expect(new Set(receipts.filter((x) => x.channel === "PARTNERS_NOTICE").map((x) => x.deliveryReference))).toEqual(new Set([`notice:${notices[0]!.id}`]));
    // 고지 완료 시각부터 30일 경계
    const done = new Date(f.now);
    expect((await chargeFor(db, f.plan, f.subs[0]!.sub, new Date(+done + 30 * DAY - 1))).amount).toBe(199000);
    expect((await chargeFor(db, f.plan, f.subs[0]!.sub, new Date(+done + 30 * DAY))).amount).toBe(249000);
  });

  it("다시 실행해도 같은 메일·공지를 다시 보내지 않는다(멱등), 메일 발송 기록이 있으면 수령 기록만 이어서 맞춘다", async () => {
    const f = await fixture();
    const sender = new FakeMailSender();
    await sendPriceChangeNotices(db, { sender, now: f.now });
    const again = await sendPriceChangeNotices(db, { sender, now: new Date(+f.now + 1000) });
    expect(again).toMatchObject({ mailSent: 0, noticeCreated: 0 });
    expect(sender.sent).toHaveLength(1);
    expect(await db.platformNotice.count()).toBe(1);
    // 메일은 나갔는데 수령 기록이 없는 상태(중간에 멈춤)는 다시 보내지 않고 기록만 만든다
    await db.subscriptionPriceNotice.deleteMany({ where: { channel: "MAIL" } });
    const fix = await sendPriceChangeNotices(db, { sender, now: new Date(+f.now + 2000) });
    expect(fix).toMatchObject({ mailSent: 0 });
    expect(sender.sent).toHaveLength(1);
    expect(await db.subscriptionPriceNotice.count({ where: { channel: "MAIL", status: "SENT" } })).toBe(1);
  });

  it("메일 공급자가 없으면 메일은 보내지도 기록하지도 않고 파트너스 공지만 남기며, 고지는 완료되지 않아 새 요금은 적용되지 않는다", async () => {
    const f = await fixture();
    const r = await sendPriceChangeNotices(db, { sender: null, now: f.now });
    expect(r).toMatchObject({ considered: 1, mailSent: 0, noticeCreated: 1, completed: 0 });
    expect(await db.mailDelivery.count()).toBe(0);
    expect(await db.subscriptionPriceNotice.count({ where: { channel: "MAIL" } })).toBe(0);
    expect((await chargeFor(db, f.plan, f.subs[0]!.sub, new Date(+f.now + 90 * DAY))).amount).toBe(199000);
  });

  it("플랫폼 한도에 걸려 못 보낸 메일은 SENT 기록을 만들지 않고, 한도가 풀리면 다시 시도해 보낸다", async () => {
    const f = await fixture();
    await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, platformDailyLimit: 0 }, update: { platformDailyLimit: 0 } });
    const sender = new FakeMailSender();
    const blocked = await sendPriceChangeNotices(db, { sender, now: f.now });
    expect(blocked).toMatchObject({ mailSent: 0, mailBlocked: 1, completed: 0 });
    expect(sender.sent).toHaveLength(0);
    expect(await db.subscriptionPriceNotice.count({ where: { channel: "MAIL" } })).toBe(0);
    await db.platformMessageSetting.update({ where: { id: 1 }, data: { platformDailyLimit: 1000 } });
    const ok = await sendPriceChangeNotices(db, { sender, now: new Date(+f.now + 1000) });
    expect(ok).toMatchObject({ mailSent: 1, completed: 1 });
  });

  it.each(["platform", "seller"] as const)("메일 비용 부담 %s: 발송 기록의 부담 주체와 파트너스 제공량·충전금 영향이 정책대로다", async (bearer) => {
    const f = await fixture();
    const sender = new FakeMailSender();
    // 제공량 안(100통)이면 두 경우 모두 무료로 나가고, 발송 기록의 sellerId만 다르다(마스터 관리자 부담 = 없음)
    const free = await sendPriceChangeNotices(db, { sender, now: f.now, bearer });
    expect(free).toMatchObject({ mailSent: 1, mailBlocked: 0, completed: 1 });
    const delivery = await db.mailDelivery.findFirstOrThrow({ where: { kind: PRICE_NOTICE_MAIL_KIND } });
    expect(delivery.sellerId).toBe(bearer === "seller" ? f.subs[0]!.seller.id : null);
    expect(delivery.charged).toBe(false);
    // 제공량 0·충전금 0: 마스터 관리자 부담은 그래도 나가고, 파트너스 부담은 멈춰 수령 기록을 만들지 않는다(후불 없음)
    await db.subscriptionPriceNotice.deleteMany({ where: { channel: "MAIL" } });
    await db.mailDelivery.deleteMany({});
    await db.subscriptionPlan.update({ where: { id: f.plan.id }, data: { mailMonthlyQuota: 0 } });
    const none = await sendPriceChangeNotices(db, { sender, now: new Date(+f.now + 1000), bearer });
    if (bearer === "platform") expect(none).toMatchObject({ mailSent: 1, mailBlocked: 0, completed: 1 });
    else {
      expect(none).toMatchObject({ mailSent: 0, mailBlocked: 1 });
      expect(await db.subscriptionPriceNotice.count({ where: { channel: "MAIL" } })).toBe(0);
    }
  });

  it("bearer를 생략하면 DEFAULT_PRICE_NOTICE_BEARER(마스터 관리자 부담)를 쓴다", async () => {
    expect(DEFAULT_PRICE_NOTICE_BEARER).toBe("platform");
    const f = await fixture();
    await sendPriceChangeNotices(db, { sender: new FakeMailSender(), now: f.now });
    expect((await db.mailDelivery.findFirstOrThrow({ where: { kind: PRICE_NOTICE_MAIL_KIND } })).sellerId).toBeNull();
  });

  it("대상이 아닌 구독(해지 예약·이미 해지·변경 뒤 시작)과 마스터 기록이 없는 변경은 건너뛴다", async () => {
    const f = await fixture({ subscribers: 3 });
    await db.sellerSubscription.update({ where: { id: f.subs[0]!.sub.id }, data: { cancelAtPeriodEnd: true } });
    await db.sellerSubscription.update({ where: { id: f.subs[1]!.sub.id }, data: { status: "CANCELED" } });
    const sender = new FakeMailSender();
    const r = await sendPriceChangeNotices(db, { sender, now: f.now });
    expect(r).toMatchObject({ considered: 1, mailSent: 1 });
    await db.subscriptionPriceChange.update({ where: { id: f.change.id }, data: { changedByAdminId: null } });
    expect(await sendPriceChangeNotices(db, { sender, now: f.now })).toMatchObject({ considered: 0 });
  });

  it("수동 실행 API: 최고관리자만, 결과를 돌려주고 로그 추적에 남기며 다른 역할은 403이다", async () => {
    const f = await fixture();
    const sess = async (role: "SUPER_ADMIN" | "OPERATIONS") => {
      const a = role === "SUPER_ADMIN" ? f.admin : await createAdmin(role);
      const s = await createAdminSession(db, a.id, {});
      return `lo_admin=${s.token}`;
    };
    const call = (cookie?: string) =>
      sendRoute(new Request("http://localhost:3000/api/admin/plans/STANDARD/price-notice", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) } }), { params: Promise.resolve({ code: "STANDARD" }) });
    expect((await call()).status).toBe(401);
    expect((await call(await sess("OPERATIONS"))).status).toBe(403);
    const ok = await call(await sess("SUPER_ADMIN"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ considered: 1, noticeCreated: 1 });
    expect(await db.auditLog.count({ where: { action: "admin.plan.price_notice_send" } })).toBe(1);
    void PASSWORD;
  });
});
