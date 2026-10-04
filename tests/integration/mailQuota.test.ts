import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as adminMailGet, PUT as adminMailPut } from "../../app/api/admin/mail-settings/route";
import { POST as planQuotaPost } from "../../app/api/admin/plans/[code]/mail-quota/route";
import { GET as sellerMailGet, PUT as sellerMailPut } from "../../app/api/seller/subscription/mail/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { type MailSender, reserveMail, sellerMailUsage, sendMail } from "../../lib/server/mail/quota";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 메일 제공량·초과 발송·플랫폼 무료 한도(대표님 결정 2026-10-05, lib/server/mail/quota.ts)
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const msg = { to: "buyer@example.com", subject: "주문 안내", html: "<p>안내</p>" };

// 보낸 통을 세는 가짜 공급자(실제 발송 없음). delayMs만큼 기다렸다가 성공, fail이면 실패.
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

async function sellerCookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

async function adminCookie(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}

const send = (sellerId: string | null, sender: MailSender) => sendMail(db, sender, { sellerId, kind: "order.paid", message: msg });
const statuses = async (sellerId: string) =>
  (await db.mailDelivery.findMany({ where: { sellerId }, orderBy: { createdAt: "asc" } })).map((d) => [d.status, d.overage]);

describe("파트너스 월 제공량", () => {
  it("제공량까지 보내고, 넘으면(초과 발송 끔 = 기본) 보내지 않고 「한도 초과로 미발송」을 남긴다. 공급자를 부르지 않는다", async () => {
    const s = await shop(2);
    const f = fakeSender();
    expect((await send(s.seller.id, f.sender)).status).toBe("SENT");
    expect((await send(s.seller.id, f.sender)).status).toBe("SENT");
    expect(await send(s.seller.id, f.sender)).toMatchObject({ status: "SKIPPED_QUOTA", overage: true });
    expect(f.keys).toHaveLength(2);
    // 발송 기록 id를 공급자 멱등키로 보낸다
    const sent = await db.mailDelivery.findMany({ where: { sellerId: s.seller.id, status: "SENT" } });
    expect(sent.map((d) => d.id).sort()).toEqual([...f.keys].sort());
    expect(sent.every((d) => d.providerMessageId && d.finishedAt)).toBe(true);
    expect(await sellerMailUsage(db, s.seller.id)).toMatchObject({ quota: 2, sent: 2, overageSent: 0, skippedQuota: 1, overageAllowed: false, overageMonthlyCap: 0 });
  });

  it("초과 발송을 켜면 월 상한까지 초과분으로 보내고, 상한에 이르면 멈춘다. 초과 금액 = 초과 통 × 통당 단가", async () => {
    const s = await shop(1);
    await db.sellerMailPolicy.create({ data: { sellerId: s.seller.id, overageAllowed: true, overageMonthlyCap: 2 } });
    await db.platformMailSetting.create({ data: { id: 1, overageUnitPrice: 15 } });
    const f = fakeSender();
    for (let i = 0; i < 4; i++) await send(s.seller.id, f.sender);
    expect(await statuses(s.seller.id)).toEqual([
      ["SENT", false],
      ["SENT", true],
      ["SENT", true],
      ["SKIPPED_QUOTA", true],
    ]);
    expect(await sellerMailUsage(db, s.seller.id)).toMatchObject({ sent: 3, overageSent: 2, overageUnitPrice: 15, overageAmount: 30 });
    // 다른 파트너스 제공량과 섞이지 않는다
    const other = await shop(1);
    expect((await send(other.seller.id, f.sender)).status).toBe("SENT");
  });

  it("보내지 못한 메일은 셈에서 빠져 다시 보낼 수 있다(두 번 표시해도 처음 결과 그대로)", async () => {
    const s = await shop(1);
    const bad = await send(s.seller.id, fakeSender({ fail: true }).sender);
    expect(bad.status).toBe("FAILED");
    expect((await send(s.seller.id, fakeSender().sender)).status).toBe("SENT");
    expect(await sellerMailUsage(db, s.seller.id)).toMatchObject({ sent: 1, failed: 1 });
  });

  it("달은 KST 기준이다: 10월 31일 23:59 KST까지는 10월, 11월 1일 0시 KST부터 새 제공량", async () => {
    const s = await shop(1);
    const r1 = await reserveMail(db, { sellerId: s.seller.id, kind: "t", now: new Date("2026-10-31T14:59:00Z") });
    const r2 = await reserveMail(db, { sellerId: s.seller.id, kind: "t", now: new Date("2026-10-31T14:59:30Z") });
    const r3 = await reserveMail(db, { sellerId: s.seller.id, kind: "t", now: new Date("2026-10-31T15:00:00Z") });
    expect([r1.ok, r2.ok, r3.ok]).toEqual([true, false, true]);
    expect((await db.mailDelivery.findMany({ where: { sellerId: s.seller.id }, orderBy: { createdAt: "asc" } })).map((d) => d.month)).toEqual(["2026-10", "2026-10", "2026-11"]);
  });

  it("동시성: 제공량 3·초과 상한 2에 12통을 한꺼번에 보내도 정확히 5통만 보낸다(보통 3·초과 2)", async () => {
    const s = await shop(3);
    await db.sellerMailPolicy.create({ data: { sellerId: s.seller.id, overageAllowed: true, overageMonthlyCap: 2 } });
    const f = fakeSender({ delayMs: 30 });
    const results = await Promise.all(Array.from({ length: 12 }, () => send(s.seller.id, f.sender)));
    expect(results.filter((r) => r.status === "SENT")).toHaveLength(5);
    expect(results.filter((r) => r.status === "SKIPPED_QUOTA")).toHaveLength(7);
    expect(f.keys).toHaveLength(5);
    expect(await sellerMailUsage(db, s.seller.id)).toMatchObject({ sent: 5, overageSent: 2, pending: 0, skippedQuota: 7 });
  });
});

describe("플랫폼 전체 무료 한도", () => {
  it("하루 한도에 이르면 누구의 메일도 보내지 않고, 80%·다 씀을 하루에 한 번씩 로그 추적에 남긴다", async () => {
    await db.platformMailSetting.create({ data: { id: 1, platformDailyLimit: 5, platformMonthlyLimit: 3000 } });
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
    // 플랫폼 한도로 막힌 통은 파트너스 제공량에 세지 않는다
    expect(await sellerMailUsage(db, a.seller.id)).toMatchObject({ sent: 2, skippedPlatformLimit: 1, skippedQuota: 0 });
  });

  it("동시성: 하루 한도 4에 여러 파트너스가 한꺼번에 10통을 보내도 4통만 보낸다", async () => {
    await db.platformMailSetting.create({ data: { id: 1, platformDailyLimit: 4 } });
    const shops = await Promise.all([shop(100), shop(100)]);
    const f = fakeSender({ delayMs: 20 });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => send(shops[i % 2].seller.id, f.sender)));
    expect(results.filter((r) => r.status === "SENT")).toHaveLength(4);
    expect(f.keys).toHaveLength(4);
  });
});

describe("파트너스 설정 API", () => {
  const put = (cookie: string, body: unknown) =>
    sellerMailPut(new Request("http://localhost:3000/api/seller/subscription/mail", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  const get = (cookie: string) => sellerMailGet(new Request("http://localhost:3000/api/seller/subscription/mail", { headers: { ...H, cookie } }));

  it("대표자가 초과 발송 허용·월 상한을 정하고(빼고 보내면 유지) 로그 추적에 남긴다. 잘못된 값 400, 직원 403, 정지 중엔 보기만", async () => {
    const s = await shop(50);
    const cookie = await sellerCookie(s.owner.email);
    const g = await get(cookie);
    expect(g.status).toBe(200);
    expect(await g.json()).toMatchObject({ quota: 50, sent: 0, overageAllowed: false, overageMonthlyCap: 0, overageUnitPrice: 0 });
    const r = await put(cookie, { overageAllowed: true, overageMonthlyCap: 300 });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ overageAllowed: true, overageMonthlyCap: 300 });
    expect(await (await put(cookie, { overageMonthlyCap: 10 })).json()).toMatchObject({ overageAllowed: true, overageMonthlyCap: 10 });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "seller.mail_policy.update", sellerId: s.seller.id }, orderBy: { createdAt: "asc" } })).toMatchObject({
      actorId: s.owner.id,
      before: { overageAllowed: false, overageMonthlyCap: 0 },
      after: { overageAllowed: true, overageMonthlyCap: 300 },
    });
    for (const body of [{}, { overageAllowed: "yes" }, { overageMonthlyCap: -1 }, { overageMonthlyCap: 1.5 }, { overageMonthlyCap: 100_001 }]) {
      const bad = await put(cookie, body);
      expect(bad.status).toBe(400);
      expect(await bad.json()).toMatchObject({ error: "invalid_mail_policy" });
    }
    const staff = await createSellerUser(s.seller.id, { permissions: ["SHOP_SETTINGS"] });
    const staffCookie = await sellerCookie(staff.email);
    expect((await put(staffCookie, { overageAllowed: false })).status).toBe(403);
    expect((await get(staffCookie)).status).toBe(403);

    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await get(cookie)).status).toBe(200);
    expect((await put(cookie, { overageAllowed: false })).status).toBe(403);
    expect(await db.sellerMailPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).toMatchObject({ overageAllowed: true, overageMonthlyCap: 10 });
  });
});

describe("마스터 관리자 메일 설정 API", () => {
  const get = (cookie: string) => adminMailGet(new Request("http://localhost:3000/api/admin/mail-settings", { headers: { ...H, cookie } }));
  const put = (cookie: string, body: unknown) =>
    adminMailPut(new Request("http://localhost:3000/api/admin/mail-settings", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  const quota = (cookie: string, code: string, body: unknown) =>
    planQuotaPost(new Request(`http://localhost:3000/api/admin/plans/${code}/mail-quota`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ code }),
    });

  it("보기는 모든 역할, 단가·플랫폼 한도·플랜 제공량 변경은 최고관리자만(로그 추적). 파트너스 세션은 401", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    const ro = await adminCookie("READ_ONLY");
    const ops = await adminCookie("OPERATIONS");
    const g = await get(ro.cookie);
    expect(g.status).toBe(200);
    const view = await g.json();
    expect(view).toMatchObject({ overageUnitPrice: 0, platformDailyLimit: 100, platformMonthlyLimit: 3000, usage: { today: { used: 0, limit: 100 }, thisMonth: { used: 0, limit: 3000 } } });
    expect(view.plans).toEqual(expect.arrayContaining([{ code: "INTEGRATED", name: "쇼핑몰 통합", mailMonthlyQuota: 100 }]));

    expect((await put(ops.cookie, { overageUnitPrice: 10 })).status).toBe(403);
    expect((await put(ro.cookie, { overageUnitPrice: 10 })).status).toBe(403);
    const ok = await put(su.cookie, { overageUnitPrice: 12 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ overageUnitPrice: 12, platformDailyLimit: 100, platformMonthlyLimit: 3000 });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "admin.mail_settings.update" } })).toMatchObject({
      actorId: su.id,
      before: { overageUnitPrice: 0 },
      after: { overageUnitPrice: 12, platformDailyLimit: 100 },
    });
    for (const body of [{}, { overageUnitPrice: -1 }, { platformDailyLimit: "100" }, { overageUnitPrice: 100_001 }]) expect((await put(su.cookie, body)).status).toBe(400);

    expect((await quota(ops.cookie, "INTEGRATED", { monthlyQuota: 500 })).status).toBe(403);
    const q = await quota(su.cookie, "INTEGRATED", { monthlyQuota: 500 });
    expect(q.status).toBe(200);
    expect(await q.json()).toEqual({ code: "INTEGRATED", mailMonthlyQuota: 500 });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "admin.plan.mail_quota_update" } })).toMatchObject({
      actorId: su.id,
      before: { mailMonthlyQuota: 100 },
      after: { mailMonthlyQuota: 500 },
    });
    expect((await quota(su.cookie, "NOPE", { monthlyQuota: 1 })).status).toBe(404);
    expect((await quota(su.cookie, "INTEGRATED", { monthlyQuota: -1 })).status).toBe(400);

    // 바꾼 제공량은 바로 판정에 쓴다
    const { seller } = await createSeller();
    await db.seller.update({ where: { id: seller.id }, data: { plan: { connect: { code: "INTEGRATED" } } } });
    expect((await sellerMailUsage(db, seller.id)).quota).toBe(500);
    const owner = await createSellerUser(seller.id, "OWNER");
    const sellerSession = await sellerCookie(owner.email);
    expect((await get(sellerSession)).status).toBe(401);
  });
});
