import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as settingsGet, PUT as settingsPut } from "../../app/api/admin/settings/notifications/route";
import { POST as resetPost } from "../../app/api/admin/settings/notifications/reset/route";
import { POST as testPost } from "../../app/api/admin/settings/notifications/test/route";
import { NOTIFY_EVENTS } from "../../lib/server/admin/notificationSettings";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { FakeMailSender, mailSender } from "../../lib/server/mail/registry";
import { createAdmin, createSeller, db, resetDb } from "./helpers";

// MA-082: 알림 채널 설정 · 이벤트별 라우팅 · 테스트 보내기 · 파트너스 발신 프로필
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { "content-type": "application/json", host: "localhost:3000", origin: BASE };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role = "SUPER_ADMIN") {
  const a = await createAdmin(role);
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
const req = (path: string, cookie: string, method = "GET", body?: unknown) => new Request(BASE + path, { method, headers: { ...H, cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const get = async (cookie: string) => json(await settingsGet(req("/api/admin/settings/notifications", cookie)));
const put = async (cookie: string, body: unknown) => json(await settingsPut(req("/api/admin/settings/notifications", cookie, "PUT", body)));
const test = async (cookie: string, body: unknown = {}) => json(await testPost(req("/api/admin/settings/notifications/test", cookie, "POST", body)));
const reset = async (cookie: string) => json(await resetPost(req("/api/admin/settings/notifications/reset", cookie, "POST", {})));

describe("조회", () => {
  it("저장 전에는 채널 4종 모두 미연결, 라우팅 10행은 정본 기본값이다. 조회 전용 관리자도 볼 수 있다", async () => {
    const r = await get(await admin("READ_ONLY"));
    expect(r.status).toBe(200);
    expect(r.body.channels.map((c: { channel: string; status: string }) => [c.channel, c.status])).toEqual([["SLACK", "NOT_CONNECTED"], ["EMAIL", "NOT_CONNECTED"], ["SMS", "NOT_CONNECTED"], ["EXTERNAL_MONITOR", "NOT_CONNECTED"]]);
    expect(r.body.channels.find((c: { channel: string }) => c.channel === "EMAIL")).toMatchObject({ minSeverity: "WARNING" });
    expect(r.body.channels.find((c: { channel: string }) => c.channel === "SMS")).toMatchObject({ minSeverity: "URGENT", includeNight: true });
    expect(r.body.routes).toHaveLength(10);
    expect(r.body.routes.every((x: { isDefault: boolean }) => x.isDefault)).toBe(true);
    expect(r.body.routes[0]).toMatchObject({ eventKey: "broadcast_payment_fail_streak", severity: "URGENT", slack: true, email: true, sms: true, roles: ["OPERATIONS", "SUPER_ADMIN"], nightSuppress: false, nightSuppressible: false });
    expect(r.body.routes[3]).toMatchObject({ eventKey: "urgent_inquiry", email: false, roles: ["CS"] });
    expect(r.body.routes[2].roles).toEqual([]); // 전체
    expect(r.body.routes[4]).toMatchObject({ severity: "WARNING", nightSuppress: true, nightSuppressible: true });
    expect(r.body.senderProfiles.alimtalk.status).toBe("NOT_CONNECTED");
    expect(r.body.senderProfiles.usage).toMatchObject({ alimtalk: 0, sms: 0, email: 0 });
  });

  it("이번 달 사용량: 보낸 메일 수와 알림톡·문자 성공 차감 건수", async () => {
    const { seller } = await createSeller();
    await db.mailDelivery.createMany({ data: [{ sellerId: seller.id, kind: "order", month: "2026-10", status: "SENT" }, { sellerId: seller.id, kind: "order", month: "2026-10", status: "FAILED" }] });
    const mk = (channel: "ALIMTALK" | "SMS" | "LMS", quantity: number, key: string) =>
      db.sellerMessageLedger.create({ data: { sellerId: seller.id, type: "DEBIT", status: "SUCCEEDED", channel, quantity, paidAmount: 0, freeAmount: 0, idempotencyKey: key, actorType: "SYSTEM" } });
    await mk("ALIMTALK", 3, "a1");
    await mk("SMS", 2, "s1");
    await mk("LMS", 1, "l1");
    const u = (await get(await admin())).body.senderProfiles.usage;
    expect(u).toMatchObject({ alimtalk: 3, sms: 3, email: 1 });
  });
});

describe("바꾸기", () => {
  it("최고관리자만 바꾼다(운영·CS·조회 전용은 403)", async () => {
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) {
      const c = await admin(role);
      expect((await put(c, { channels: { SLACK: { target: "#ops" } } })).status).toBe(403);
      expect((await test(c)).status).toBe(403);
      expect((await reset(c)).status).toBe(403);
    }
  });

  it("이메일은 주소가 올바르면 연결됨, 슬랙·문자는 저장돼도 미연결, 감시 주소의 계정 정보·쿼리는 저장하지 않는다. 로그 추적에는 값이 남지 않는다", async () => {
    const c = await admin();
    const r = await put(c, { channels: { EMAIL: { target: "ops@onq.example", minSeverity: "WARNING" }, SLACK: { target: "#ops-alerts" }, SMS: { target: "당직 번호", includeNight: true }, EXTERNAL_MONITOR: { target: "https://user:pw@mon.example.com/hook?token=SECRET" } } });
    expect(r.status).toBe(200);
    expect(r.body.changed.channels.sort()).toEqual(["EMAIL", "EXTERNAL_MONITOR", "SLACK", "SMS"]);
    const by = Object.fromEntries(r.body.settings.channels.map((x: { channel: string }) => [x.channel, x]));
    expect(by.EMAIL).toMatchObject({ status: "CONNECTED", target: "ops@onq.example" });
    const latestChannel = await db.adminNotificationChannel.findFirstOrThrow({ orderBy: { updatedAt: "desc" } });
    expect(r.body.settings.updatedAt).toBe(latestChannel.updatedAt.toISOString());
    expect(by.SLACK).toMatchObject({ status: "NOT_CONNECTED", target: "#ops-alerts" });
    expect(by.SMS.status).toBe("NOT_CONNECTED");
    expect(by.EXTERNAL_MONITOR.target).toBe("https://mon.example.com/hook");
    expect(JSON.stringify(by)).not.toContain("SECRET");
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "admin.notification_settings.update" } });
    expect(JSON.stringify(audit.after)).not.toContain("ops@onq.example");
    expect(audit.after).toMatchObject({ channels: expect.arrayContaining(["EMAIL"]) });
    // 같은 값을 다시 보내면 바뀐 것이 없다
    expect((await put(c, { channels: { EMAIL: { target: "ops@onq.example" } } })).body.changed).toEqual({ channels: [], routes: [] });
    // 잘못된 입력
    expect((await put(c, { channels: { EMAIL: { target: "not-an-email" } } })).status).toBe(400);
    expect((await put(c, { channels: { EXTERNAL_MONITOR: { target: "ftp://x" } } })).status).toBe(400);
    expect((await put(c, { channels: { SLACK: { target: "x".repeat(101) } } })).status).toBe(400);
    expect((await put(c, { channels: { NOPE: { target: "x" } } })).status).toBe(400);
    expect((await put(c, { channels: { SMS: { minSeverity: "HIGH" } } })).status).toBe(400);
  });

  it("라우팅: 바꾼 이벤트만 저장하고 기본값과 같아지면 지운다. 긴급은 야간 억제 불가, 이벤트·역할 검사, 기본값 복원", async () => {
    const c = await admin();
    const ev = (key: string) => NOTIFY_EVENTS.find((e) => e.eventKey === key)!;
    const base = { eventKey: "reward_payout_failed", slack: true, email: true, sms: false, roles: ["OPERATIONS", "CS"], nightSuppress: false };
    const r1 = await put(c, { routes: [base] });
    expect(r1.status).toBe(200);
    expect(r1.body.changed.routes).toEqual(["reward_payout_failed"]);
    const row = r1.body.settings.routes.find((x: { eventKey: string }) => x.eventKey === "reward_payout_failed");
    expect(row).toMatchObject({ email: true, roles: ["OPERATIONS", "CS"], nightSuppress: false, isDefault: false });
    expect(await db.adminNotificationRoute.count()).toBe(1);
    // 기본값과 같게 되돌리면 저장된 행을 지운다
    const d = ev("reward_payout_failed");
    const r2 = await put(c, { routes: [{ eventKey: d.eventKey, slack: d.slack, email: d.email, sms: d.sms, roles: d.roles, nightSuppress: d.nightSuppress }] });
    expect(r2.body.changed.routes).toEqual(["reward_payout_failed"]);
    expect(await db.adminNotificationRoute.count()).toBe(0);
    // 긴급은 야간 억제를 켤 수 없다
    const u = ev("platform_outage");
    expect((await put(c, { routes: [{ eventKey: u.eventKey, slack: true, email: true, sms: true, roles: [], nightSuppress: true }] })).body).toMatchObject({ error: "urgent_no_night_suppress" });
    expect((await put(c, { routes: [{ ...base, eventKey: "nope" }] })).body.error).toBe("invalid_event");
    expect((await put(c, { routes: [{ ...base, roles: ["BOSS"] }] })).body.error).toBe("invalid_roles");
    expect((await put(c, { routes: [{ ...base, slack: "yes" }] })).body.error).toBe("invalid_route");
    expect((await put(c, { routes: [base, base] })).body.error).toBe("invalid_event");
    // 기본값 복원
    await put(c, { routes: [base, { eventKey: "application_overdue_48h", slack: false, email: true, sms: false, roles: ["CS"], nightSuppress: true }] });
    expect(await db.adminNotificationRoute.count()).toBe(2);
    const rr = await reset(c);
    expect(rr.body.reset).toBe(2);
    expect(rr.body.settings.routes.every((x: { isDefault: boolean }) => x.isDefault)).toBe(true);
  });
});

describe("테스트 보내기", () => {
  it("연결된 이메일만 실제로 보내고(가짜 공급자에 쌓임) 나머지는 미연결로 알려 준다. 마지막 발송이 남는다", async () => {
    const c = await admin();
    const sender = mailSender() as FakeMailSender;
    sender.sent.length = 0;
    // 주소를 넣기 전에는 이메일도 미연결
    const none = await test(c);
    expect(none.body.results.map((x: { status: string }) => x.status)).toEqual(["NOT_CONNECTED", "NOT_CONNECTED", "NOT_CONNECTED", "NOT_CONNECTED"]);
    expect(sender.sent).toHaveLength(0);
    await put(c, { channels: { EMAIL: { target: "ops@onq.example" }, SLACK: { target: "#ops-alerts" } } });
    const r = await test(c);
    expect(r.status).toBe(200);
    expect(Object.fromEntries(r.body.results.map((x: { channel: string; status: string }) => [x.channel, x.status]))).toEqual({ SLACK: "NOT_CONNECTED", EMAIL: "SENT", SMS: "NOT_CONNECTED", EXTERNAL_MONITOR: "NOT_CONNECTED" });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].to).toBe("ops@onq.example");
    const email = r.body.settings.channels.find((x: { channel: string }) => x.channel === "EMAIL");
    expect(email.lastSentAt).toBeTruthy();
    expect(r.body.settings.senderProfiles.usage.email).toBe(1);
    expect(await db.mailDelivery.findFirstOrThrow({ where: { kind: "admin_notification_test" } })).toMatchObject({ sellerId: null, status: "SENT", charged: false });
    // 채널을 골라 보내기, 모르는 채널은 400
    expect((await test(c, { channels: ["SLACK"] })).body.results).toEqual([{ channel: "SLACK", status: "NOT_CONNECTED" }]);
    expect((await test(c, { channels: ["FAX"] })).status).toBe(400);
  });

  it("메일 공급자가 오류를 내면 FAILED로 알리고 마지막 오류를 남긴다(상태는 오류, 주소를 다시 저장하면 지워짐)", async () => {
    const c = await admin();
    await put(c, { channels: { EMAIL: { target: "ops@onq.example" } } });
    const sender = mailSender() as FakeMailSender;
    const orig = sender.send.bind(sender);
    sender.send = async () => {
      throw new Error("provider_down");
    };
    try {
      const r = await test(c, { channels: ["EMAIL"] });
      expect(r.body.results).toEqual([{ channel: "EMAIL", status: "FAILED" }]);
      expect(r.body.settings.channels.find((x: { channel: string }) => x.channel === "EMAIL")).toMatchObject({ status: "ERROR", lastError: "send_failed", lastSentAt: null });
      expect(r.body.settings.senderProfiles.usage.email).toBe(0);
      expect(await db.mailDelivery.findFirstOrThrow({ where: { kind: "admin_notification_test" } })).toMatchObject({ status: "FAILED" });
      expect(await db.adminNotificationChannel.findUniqueOrThrow({ where: { channel: "EMAIL" } })).toMatchObject({ lastError: "send_failed" });
    } finally {
      sender.send = orig;
    }
    const retried = await test(c, { channels: ["EMAIL"] });
    expect(retried.body.results).toEqual([{ channel: "EMAIL", status: "SENT" }]);
    expect(retried.body.settings.channels.find((x: { channel: string }) => x.channel === "EMAIL")).toMatchObject({ status: "CONNECTED", lastError: null });
    expect(retried.body.settings.senderProfiles.usage.email).toBe(1);
    await put(c, { channels: { EMAIL: { target: "ops2@onq.example" } } });
    expect((await db.adminNotificationChannel.findUniqueOrThrow({ where: { channel: "EMAIL" } })).lastError).toBeNull();
  });

  it.each(["platformDailyLimit", "platformMonthlyLimit"] as const)("%s를 다 쓰면 공급자를 호출하지 않고 실패·미발송 기록을 남긴다", async (limit) => {
    const c = await admin();
    await put(c, { channels: { EMAIL: { target: "ops@onq.example" } } });
    await db.platformMessageSetting.update({ where: { id: 1 }, data: { [limit]: 1 } });
    const sender = mailSender() as FakeMailSender;
    sender.sent.length = 0;
    expect((await test(c, { channels: ["EMAIL"] })).body.results).toEqual([{ channel: "EMAIL", status: "SENT" }]);
    const sentAt = (await db.adminNotificationChannel.findUniqueOrThrow({ where: { channel: "EMAIL" } })).lastSentAt;
    const capped = await test(c, { channels: ["EMAIL"] });
    expect(capped.body.results).toEqual([{ channel: "EMAIL", status: "FAILED" }]);
    expect(capped.body.settings.channels.find((x: { channel: string }) => x.channel === "EMAIL")).toMatchObject({ status: "ERROR", lastError: "platform_limit", lastSentAt: sentAt!.toISOString() });
    expect(capped.body.settings.senderProfiles.usage.email).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(await db.mailDelivery.count({ where: { kind: "admin_notification_test", status: "SKIPPED_PLATFORM_LIMIT" } })).toBe(1);
  });
});
