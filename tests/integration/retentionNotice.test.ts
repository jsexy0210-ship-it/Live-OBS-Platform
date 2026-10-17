import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as sendRoute } from "../../app/api/admin/retention-notice/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { RETENTION_NOTICE_LEAD_DAYS, RETENTION_NOTICE_MAIL_KIND, retentionDeletionEnabled, retentionDeletionReport, sendRetentionNotices } from "../../lib/server/billing/retentionNotice";
import { dbNow } from "../../lib/server/billing/subscription";
import { FakeMailSender } from "../../lib/server/mail/registry";
import { createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 삭제 전 안내 메일: 해지(serviceEndedAt)+90일 보관 종료 전 안내 기간의 파트너스에 대표자 메일 1통(마스터 관리자 부담). 삭제는 하지 않는다.
const DAY = 86_400_000;
beforeEach(resetDb);
beforeAll(() => {
  process.env.APP_ORIGIN = "https://onq.example.com";
});
afterAll(() => db.$disconnect());

// 해지한 지 daysAgo일 된 파트너스
async function ended(daysAgo: number, now: Date, email = `o${daysAgo}@example.com`) {
  const { seller } = await createSeller();
  await createSellerUser(seller.id, "OWNER", email);
  const serviceEndedAt = new Date(+now - daysAgo * DAY);
  await db.seller.update({ where: { id: seller.id }, data: { serviceEndedAt } });
  return { seller, serviceEndedAt };
}

describe("삭제 전 안내 메일 작업", () => {
  it("안내 기간(보관 종료 14일 전부터)에 든 해지 파트너스만 메일 1통을 받고, 마스터 관리자 부담이라 파트너스 제공량·충전금에 기록되지 않는다", async () => {
    const now = await dbNow(db);
    const lead = RETENTION_NOTICE_LEAD_DAYS;
    const early = await ended(90 - lead - 1, now, "early@example.com"); // 아직 안내 전
    const edge = await ended(90 - lead, now, "edge@example.com"); // 안내 기간 시작(포함)
    const mid = await ended(80, now, "mid@example.com");
    const over = await ended(90, now, "over@example.com"); // 보관 종료: 안내가 안 나갔으면 계속 대상(알린 날부터 14일 뒤를 삭제 예정일로 안내)
    const sender = new FakeMailSender();
    const r = await sendRetentionNotices(db, { sender, now });
    expect(r).toMatchObject({ considered: 3, mailSent: 3, mailBlocked: 0 });
    expect(sender.sent.map((m) => m.to).sort()).toEqual(["edge@example.com", "mid@example.com", "over@example.com"]);
    expect(sender.sent[0]?.subject).toContain("삭제");
    const rows = await db.mailDelivery.findMany({ where: { kind: RETENTION_NOTICE_MAIL_KIND } });
    expect(rows).toHaveLength(3);
    expect(rows.every((m) => m.sellerId === null && m.status === "SENT" && !m.charged && m.ledgerId === null)).toBe(true);
    expect(await db.sellerMessageLedger.count()).toBe(0);
    void [early, edge, mid, over];
  });

  it("다시 실행해도 같은 해지에는 다시 보내지 않고, 다시 구독했다 새로 해지하면 새 안내를 받는다", async () => {
    const now = await dbNow(db);
    const a = await ended(80, now);
    const sender = new FakeMailSender();
    await sendRetentionNotices(db, { sender, now });
    expect(await sendRetentionNotices(db, { sender, now })).toMatchObject({ considered: 1, mailSent: 0, alreadySent: 1 });
    expect(sender.sent).toHaveLength(1);
    await db.seller.update({ where: { id: a.seller.id }, data: { serviceEndedAt: new Date(+now - 79 * DAY) } });
    expect(await sendRetentionNotices(db, { sender, now })).toMatchObject({ mailSent: 1 });
    expect(sender.sent).toHaveLength(2);
  });

  it("동시에 두 번 실행해도 한 통만 나간다", async () => {
    const now = await dbNow(db);
    await ended(80, now);
    const sender = new FakeMailSender();
    await Promise.all([sendRetentionNotices(db, { sender, now }), sendRetentionNotices(db, { sender, now })]);
    expect(sender.sent).toHaveLength(1);
  });

  it("보내다 멈춘 PENDING은 새 발송 기록을 만들지 않고 같은 기록·같은 멱등 키로 이어서 보낸다", async () => {
    const now = await dbNow(db);
    const a = await ended(80, now);
    const refId = `${a.seller.id}:${a.serviceEndedAt.toISOString()}`;
    const stuck = await db.mailDelivery.create({ data: { kind: RETENTION_NOTICE_MAIL_KIND, refId, month: "2026-10", status: "PENDING" } });
    const sender = new FakeMailSender();
    expect(await sendRetentionNotices(db, { sender, now })).toMatchObject({ mailSent: 1 });
    expect(sender.sent.map((m) => m.idempotencyKey)).toEqual([stuck.id]);
    const rows = await db.mailDelivery.findMany({ where: { refId } });
    expect(rows).toEqual([expect.objectContaining({ id: stuck.id, status: "SENT" })]);
  });

  it("못 보낸 채 보관 기간이 지나도 다음 실행에서 계속 보낸다(삭제 예정일은 알린 날부터 14일 뒤)", async () => {
    const now = await dbNow(db);
    await ended(89, now);
    await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, platformDailyLimit: 0 }, update: { platformDailyLimit: 0 } });
    const sender = new FakeMailSender();
    expect(await sendRetentionNotices(db, { sender, now })).toMatchObject({ mailSent: 0, mailBlocked: 1 });
    await db.platformMessageSetting.update({ where: { id: 1 }, data: { platformDailyLimit: 1000 } });
    const later = new Date(+now + 2 * DAY); // 해지 91일째: 보관 기간이 이미 지남
    expect(await sendRetentionNotices(db, { sender, now: later })).toMatchObject({ mailSent: 1 });
    expect(sender.sent[0]?.text).toContain(new Date(+later + 14 * DAY + 9 * 3_600_000).toISOString().slice(0, 10));
  });

  it("보내기 직전에 다시 구독해 해지가 풀렸으면 안내를 보내지 않는다", async () => {
    const now = await dbNow(db);
    const a = await ended(80, now);
    const releaser = db.$transaction(async (t) => {
      await t.$queryRaw`SELECT id FROM "Seller" WHERE id = ${a.seller.id}::uuid FOR UPDATE`;
      await new Promise((r) => setTimeout(r, 400));
      await t.seller.update({ where: { id: a.seller.id }, data: { serviceEndedAt: null } });
    });
    await new Promise((r) => setTimeout(r, 150));
    const sender = new FakeMailSender();
    await sendRetentionNotices(db, { sender, now });
    await releaser;
    expect(sender.sent).toHaveLength(0);
    expect(await db.mailDelivery.count()).toBe(0);
  });

  it("메일 공급자가 없으면 보내지도 기록하지도 않는다", async () => {
    const now = await dbNow(db);
    await ended(80, now);
    expect(await sendRetentionNotices(db, { sender: null, now })).toMatchObject({ considered: 0, mailSent: 0 });
    expect(await db.mailDelivery.count()).toBe(0);
  });

  it("마스터 설정 한도로 못 보내면 SENT를 만들지 않고 다음 실행에서 다시 보낸다", async () => {
    const now = await dbNow(db);
    await ended(80, now);
    await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, platformDailyLimit: 0 }, update: { platformDailyLimit: 0 } });
    const sender = new FakeMailSender();
    expect(await sendRetentionNotices(db, { sender, now })).toMatchObject({ mailSent: 0, mailBlocked: 1 });
    expect(sender.sent).toHaveLength(0);
    await db.platformMessageSetting.update({ where: { id: 1 }, data: { platformDailyLimit: 1000 } });
    expect(await sendRetentionNotices(db, { sender, now })).toMatchObject({ mailSent: 1 });
  });

  it("삭제 후보 보고는 읽기 전용이다: 보관 종료 파트너스와 안내 여부만 보고하고 삭제 스위치는 기본 꺼짐, 실행 0", async () => {
    const now = await dbNow(db);
    const over = await ended(95, now, "over@example.com");
    await ended(80, now);
    const sender = new FakeMailSender();
    await sendRetentionNotices(db, { sender, now });
    const rep = await retentionDeletionReport(db, { now });
    expect(rep).toMatchObject({ mode: "DRY_RUN", deletionEnabled: false, executed: 0 });
    // 안내가 나간 직후라 아직 삭제 후보가 아니다(안내 뒤 14일이 지나야 deletable)
    expect(rep.candidates).toEqual([expect.objectContaining({ sellerId: over.seller.id, noticeSent: true, deletable: false })]);
    // 안내 뒤 14일이 지나면 deletable
    const after14 = await retentionDeletionReport(db, { now: new Date(+now + 14 * DAY + 60_000) });
    expect(after14.candidates.find((c) => c.sellerId === over.seller.id)).toMatchObject({ deletable: true });
    expect(retentionDeletionEnabled({})).toBe(false);
    expect(retentionDeletionEnabled({ RETENTION_DELETION_ENABLED: "true" })).toBe(true);
    // 보고만 했고 파트너스 데이터는 그대로다
    expect(await db.seller.count({ where: { id: over.seller.id } })).toBe(1);
  });

  it("삭제 후보 보고는 id 순서로 나눠 읽을 수 있고 전체 수를 함께 알린다(빠지는 후보 없음)", async () => {
    const now = await dbNow(db);
    for (let i = 0; i < 5; i++) await ended(100 + i, now, `p${i}@example.com`);
    const seen: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await retentionDeletionReport(db, { now, limit: 2, afterId: after });
      expect(page.total).toBe(5);
      seen.push(...page.candidates.map((c) => c.sellerId));
      if (!page.nextAfterId) break;
      after = page.nextAfterId;
    }
    expect(new Set(seen).size).toBe(5);
    expect(seen).toHaveLength(5);
  });

  it("수동 실행 API: 최고관리자만, 결과·보고를 돌려주고 로그 추적에 남기며 다른 역할은 403이다", async () => {
    const now = await dbNow(db);
    await ended(80, now);
    const admin = await createAdmin("SUPER_ADMIN");
    const sess = async (a: { id: string }) => `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
    const call = (cookie?: string) =>
      sendRoute(new Request("http://localhost:3000/api/admin/retention-notice", { method: "POST", headers: { host: "localhost:3000", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) } }));
    expect((await call()).status).toBe(401);
    expect((await call(await sess(await createAdmin("OPERATIONS")))).status).toBe(403);
    const ok = await call(await sess(admin));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ notices: { considered: 1 }, report: { executed: 0, deletionEnabled: false } });
    expect(await db.auditLog.count({ where: { action: "admin.retention.notice_send" } })).toBe(1);
  });
});
