import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as policyGet } from "../../app/api/admin/settings/policy/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { createAdmin, db, resetDb, seedPlans } from "./helpers";

// 플랫폼 기본 정책(MA-081): 기존 값을 모아 보는 읽기 전용 조회. 전 역할 조회, 비로그인 차단, 비밀값 미노출, 저장 없음.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { host: "localhost:3000" };
async function adminCookie(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "READ_ONLY") {
  const a = await createAdmin(role);
  return `lo_admin=${(await createAdminSession(db, a.id, {})).token}`;
}
const get = (cookie?: string) => policyGet(new Request("http://localhost:3000/api/admin/settings/policy", { headers: { ...H, ...(cookie ? { cookie } : {}) } }));

describe("플랫폼 기본 정책 GET /api/admin/settings/policy", () => {
  it("로그인 없이는 401", async () => {
    expect((await get()).status).toBe(401);
  });

  it("조회 전용 계정도 요금제·발송·점검·도우미 값을 한 번에 본다", async () => {
    await seedPlans();
    const r = await get(await adminCookie("READ_ONLY"));
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const b = await r.json();
    expect(b.plans.length).toBeGreaterThan(0);
    expect(b.plans[0]).toEqual(expect.objectContaining({ code: expect.any(String), mailMonthlyQuota: expect.any(Number) }));
    expect(b.message).toEqual(expect.objectContaining({ chargingEnabled: false, platformDailyLimit: 100, platformMonthlyLimit: 3000 }));
    expect(b.message.prices.length).toBe(11);
    expect(b.maintenance).toEqual(expect.objectContaining({ enabled: false, active: false }));
    expect(b.assistant.settings).toEqual(expect.objectContaining({ enabled: false, monthlyBudgetWon: 10_000 }));
    expect(b.assistant.keyConfigured).toBe(false);
    expect(Object.keys(b.edit).sort()).toEqual(["assistant", "maintenance", "message", "plans"]);
  });

  it("도우미 API 키 값은 응답에 없고, 조회만으로 DB에 아무것도 쓰지 않는다", async () => {
    const prev = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "secret-key-value-123";
    try {
      const before = await db.platformMessageSetting.count();
      const r = await get(await adminCookie("CS"));
      const b = await r.json();
      expect(b.assistant.keyConfigured).toBe(true);
      expect(JSON.stringify(b)).not.toContain("secret-key-value-123");
      expect(await db.platformMessageSetting.count()).toBe(before);
    } finally {
      if (prev === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prev;
    }
  });
});
