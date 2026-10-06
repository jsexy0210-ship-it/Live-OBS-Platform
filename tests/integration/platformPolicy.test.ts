import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as policyGet, PATCH as policyPatch } from "../../app/api/admin/settings/policy/route";
import { POST as supplementRoute } from "../../app/api/admin/sellers/[sellerId]/supplement/route";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { startImpersonation } from "../../lib/server/auth/impersonation";
import { policyValue, POLICY_DEFS } from "../../lib/server/admin/platformPolicy";
import { prisma } from "../../lib/server/db";
import { createAdmin, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// 플랫폼 기본 정책 저장(MA-081). 조회는 전 역할, 변경은 최고관리자만, 범위 검증, 바뀐 키만 로그 추적(before/after), 이미 동작하는 기능에 연결.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const get = async (cookie: string) => (await policyGet(new Request("http://localhost:3000/api/admin/settings/policy", { headers: { ...H, cookie } }))).json();
const patch = (cookie: string, body: unknown) => policyPatch(new Request("http://localhost:3000/api/admin/settings/policy", { method: "PATCH", headers: { ...H, cookie }, body: JSON.stringify(body) }));
const item = (policy: { key: string }[], key: string) => policy.find((p) => p.key === key) as Record<string, unknown>;

describe("플랫폼 기본 정책 저장", () => {
  it("조회는 기본값(현재 코드 값)·범위·적용 여부를 준다", async () => {
    const { cookie } = await admin("READ_ONLY");
    const { policy } = await get(cookie);
    expect(policy).toHaveLength(POLICY_DEFS.length);
    expect(item(policy, "overdueLockDays")).toMatchObject({ value: 7, default: 7, min: 1, max: 60, applied: true, updatedAt: null });
    expect(item(policy, "paymentRetryCount")).toMatchObject({ value: 3, applied: true });
    expect(item(policy, "lockToCloseDays")).toMatchObject({ value: 30, applied: true });
    expect(item(policy, "reviewTargetHours")).toMatchObject({ value: 48, options: [24, 48, 72], applied: true });
    expect(item(policy, "supplementAutoRejectDays")).toMatchObject({ value: 7, options: [3, 7, 0], applied: true });
    expect(item(policy, "bizStatusAutoCheck")).toMatchObject({ kind: "bool", value: true, applied: false });
    expect(item(policy, "maxEarnRatePercent")).toMatchObject({ value: 10, applied: false });
    expect(item(policy, "manualGrantMax")).toMatchObject({ value: 1_000_000, applied: false });
    expect(item(policy, "adminSessionHours")).toMatchObject({ value: 8, applied: true });
  });

  it("최고관리자만 바꾸고(그 밖 403), 바뀐 키만 before/after로 로그 추적에 남는다. 같은 값은 로그 없음", async () => {
    const su = await admin("SUPER_ADMIN");
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) {
      expect((await patch((await admin(role)).cookie, { values: { overdueLockDays: 10 } })).status, role).toBe(403);
    }
    expect(await db.platformPolicy.count()).toBe(0);
    const r = await patch(su.cookie, { values: { overdueLockDays: 10, maxEarnRatePercent: 8, carryOverAlways: true, paymentRetryCount: 3 } });
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.changed.sort()).toEqual(["carryOverAlways", "maxEarnRatePercent", "overdueLockDays"]);
    expect(item(b.policy, "overdueLockDays")).toMatchObject({ value: 10 });
    expect(item(b.policy, "carryOverAlways")).toMatchObject({ value: true });
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "platform.policy.update" } });
    expect(log).toMatchObject({ actorId: su.id, before: { overdueLockDays: 7, maxEarnRatePercent: 10, carryOverAlways: false }, after: { overdueLockDays: 10, maxEarnRatePercent: 8, carryOverAlways: true } });
    expect((await (await patch(su.cookie, { values: { overdueLockDays: 10 } })).json()).changed).toEqual([]);
    expect(await db.auditLog.count({ where: { action: "platform.policy.update" } })).toBe(1);
  });

  it("범위 밖·모르는 키·잘못된 형식은 400이고 아무것도 저장하지 않는다. 요금 변경 사전 고지는 30일 미만 불가", async () => {
    const su = await admin("SUPER_ADMIN");
    const bad: [unknown, string, string?][] = [
      [{ values: {} }, "invalid_policy"],
      [{}, "invalid_policy"],
      [{ values: { nope: 1 } }, "invalid_policy", "nope"],
      [{ values: { overdueLockDays: 0 } }, "invalid_policy", "overdueLockDays"],
      [{ values: { overdueLockDays: 61 } }, "invalid_policy"],
      [{ values: { overdueLockDays: 7.5 } }, "invalid_policy"],
      [{ values: { overdueLockDays: "7" } }, "invalid_policy"],
      [{ values: { reviewTargetHours: 36 } }, "invalid_policy"],
      [{ values: { supplementAutoRejectDays: 5 } }, "invalid_policy"],
      [{ values: { bizStatusAutoCheck: 1 } }, "invalid_policy"],
      [{ values: { priceNoticeDays: 20 } }, "price_notice_min", "priceNoticeDays"],
      [{ values: { overdueLockDays: 12, manualGrantMax: 10 } }, "invalid_policy", "manualGrantMax"],
    ];
    for (const [body, error, field] of bad) {
      const r = await patch(su.cookie, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      const j = await r.json();
      expect(j.error).toBe(error);
      if (field) expect(j.field).toBe(field);
    }
    expect(await db.platformPolicy.count()).toBe(0);
    expect((await patch(su.cookie, { values: { priceNoticeDays: 45, supplementAutoRejectDays: 0, reviewTargetHours: 72 } })).status).toBe(200);
  });

  it("이미 동작하는 기능이 값을 읽는다: 보완 요청 기한·대신 보기 기본 세션", async () => {
    const su = await admin("SUPER_ADMIN");
    await patch(su.cookie, { values: { supplementAutoRejectDays: 3, impersonationMinutes: 10 } });
    expect(await policyValue(db, "supplementAutoRejectDays")).toBe(3);
    await seedPlans();
    const { seller } = await createSeller();
    await createSellerUser(seller.id, "OWNER");
    await db.seller.update({ where: { id: seller.id }, data: { status: "PENDING", reviewReasons: ["mail_order_number_invalid"] } });
    const s = await supplementRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie: su.cookie }, body: JSON.stringify({ reason: "서류가 흐립니다" }) }), {
      params: Promise.resolve({ sellerId: seller.id }),
    });
    expect(s.status).toBe(200);
    const rev = await db.sellerApplicationReview.findUniqueOrThrow({ where: { sellerId: seller.id } });
    expect(Math.round((rev.supplementDueAt!.getTime() - rev.supplementRequestedAt!.getTime()) / 86_400_000)).toBe(3);

    const { seller: shop } = await createSeller();
    const now = new Date();
    const imp = await startImpersonation(db, { admin: await db.platformAdmin.findUniqueOrThrow({ where: { id: su.id } }), sessionId: "x" } as never, shop.id, "고객 문의 확인", {}, now);
    if (!imp.ok) throw new Error(imp.reason);
    expect(imp.expiresAt.getTime() - now.getTime()).toBe(10 * 60_000);
    // 보완 안 함(0)이면 기한이 없다
    await patch(su.cookie, { values: { supplementAutoRejectDays: 0 } });
    const { seller: nodue } = await createSeller();
    await createSellerUser(nodue.id, "OWNER");
    await db.seller.update({ where: { id: nodue.id }, data: { status: "PENDING", reviewReasons: ["mail_order_number_invalid"] } });
    await supplementRoute(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie: su.cookie }, body: JSON.stringify({ reason: "서류가 흐립니다" }) }), { params: Promise.resolve({ sellerId: nodue.id }) });
    expect((await db.sellerApplicationReview.findUniqueOrThrow({ where: { sellerId: nodue.id } })).supplementDueAt).toBeNull();
  });
});

describe("관리자 세션 정책 적용(MA-081)", () => {
  it("최대 유지 시간(adminSessionHours)은 새 로그인부터, 미활동 분(adminIdleMinutes)은 바로 적용된다", async () => {
    const a = await createAdmin("OPERATIONS");
    const HOUR = 3_600_000;
    const t0 = new Date();
    const s1 = await createAdminSession(db, a.id, { now: t0 });
    expect(s1.expiresAt.getTime() - t0.getTime()).toBe(8 * HOUR);
    await db.platformPolicy.create({ data: { key: "adminSessionHours", intValue: 2 } });
    const s2 = await createAdminSession(db, a.id, { now: t0 });
    expect(s2.expiresAt.getTime() - t0.getTime()).toBe(2 * HOUR);

    const at = (min: number) => new Date(t0.getTime() + min * 60_000);
    const s0 = await createAdminSession(db, a.id, { now: t0 });
    expect(await resolveAdminSession(db, s0.token, at(29))).not.toBeNull();
    expect(await resolveAdminSession(db, s1.token, at(31))).toBeNull(); // 기본 30분
    const s3 = await createAdminSession(db, a.id, { now: t0 });
    await db.platformPolicy.create({ data: { key: "adminIdleMinutes", intValue: 5 } });
    expect(await resolveAdminSession(db, s3.token, at(6))).toBeNull();
    const s4 = await createAdminSession(db, a.id, { now: t0 });
    expect(await resolveAdminSession(db, s4.token, at(4))).not.toBeNull();
  });
});
