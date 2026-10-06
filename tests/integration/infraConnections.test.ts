import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as listRoute } from "../../app/api/admin/infra/connections/route";
import { PUT as expiryRoute } from "../../app/api/admin/infra/connections/[key]/expiry/route";
import { GET as summaryRoute } from "../../app/api/admin/infra/summary/route";
import { GeminiError } from "../../lib/server/assistant/gemini";
import { askAssistant } from "../../lib/server/assistant/service";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { connectionStatus, recordConnectionResult } from "../../lib/server/ops/connections";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const adminCookie = async (role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") => {
  const admin = await createAdmin(role);
  const s = await createAdminSession(db, admin.id, {});
  return { cookie: `lo_admin=${s.token}`, id: admin.id };
};
const list = async (cookie: string) => (await listRoute(new Request(`${BASE}/api/admin/infra/connections`, { headers: { cookie } }))).json();
const put = (cookie: string, key: string, body: unknown) =>
  expiryRoute(new Request(`${BASE}/api/admin/infra/connections/${key}/expiry`, { method: "PUT", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ key }) });
const kstYmd = (offsetDays: number) => new Date(Date.now() + 9 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
type Conn = { key: string; daysLeft: number | null; status: string; lastOkAt: string | null };
const find = (body: { connections: Conn[] }, key: string) => body.connections.find((c) => c.key === key)!;

describe("외부 연결 만료·상태", () => {
  it("상태 판정: 인증 오류 > 만료 임박 > 연결 전 > 정상", () => {
    const now = new Date("2026-10-06T00:00:00Z");
    const at = (d: string) => new Date(d);
    expect(connectionStatus({ expiresAt: null, lastOkAt: null, lastAuthErrorAt: null }, now)).toBe("not_connected");
    expect(connectionStatus({ expiresAt: null, lastOkAt: at("2026-10-05T00:00:00Z"), lastAuthErrorAt: null }, now)).toBe("ok");
    expect(connectionStatus({ expiresAt: at("2026-12-31T00:00:00Z"), lastOkAt: at("2026-10-05T00:00:00Z"), lastAuthErrorAt: null }, now)).toBe("ok");
    expect(connectionStatus({ expiresAt: at("2026-10-20T00:00:00Z"), lastOkAt: at("2026-10-05T00:00:00Z"), lastAuthErrorAt: null }, now)).toBe("expiring");
    expect(connectionStatus({ expiresAt: at("2026-10-01T00:00:00Z"), lastOkAt: null, lastAuthErrorAt: null }, now)).toBe("expiring");
    // 오류 뒤 정상 호출이 있으면 오류가 아니다
    expect(connectionStatus({ expiresAt: null, lastOkAt: at("2026-10-05T12:00:00Z"), lastAuthErrorAt: at("2026-10-05T00:00:00Z") }, now)).toBe("ok");
    expect(connectionStatus({ expiresAt: at("2026-10-01T00:00:00Z"), lastOkAt: at("2026-10-05T00:00:00Z"), lastAuthErrorAt: at("2026-10-05T12:00:00Z") }, now)).toBe("auth_error");
  });

  it("조회·입력은 최고관리자만(401·403). 전체 연결이 처음엔 연결 전이고 키 값은 없다", async () => {
    expect((await listRoute(new Request(`${BASE}/api/admin/infra/connections`))).status).toBe(401);
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) {
      const { cookie } = await adminCookie(role);
      expect((await listRoute(new Request(`${BASE}/api/admin/infra/connections`, { headers: { cookie } }))).status).toBe(403);
      expect((await put(cookie, "gemini", { expiresOn: "2027-01-01", expectedVersion: 0 })).status).toBe(403);
    }
    const { cookie } = await adminCookie("SUPER_ADMIN");
    const body = await list(cookie);
    expect(body.connections.map((c: { key: string }) => c.key)).toEqual(["nts_business_status", "ftc_mail_order", "payment_gateway", "mail", "identity_verification", "gemini"]);
    expect(find(body, "gemini")).toMatchObject({ expiresOn: null, daysLeft: null, lastOkAt: null, status: "not_connected", version: 0 });
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|secret|password/i);
  });

  it("만료일 입력: 검증·겹침 방지·지우기, 로그 추적에 전후 값이 남고 남은 일수·만료 임박이 계산된다", async () => {
    const { cookie, id } = await adminCookie("SUPER_ADMIN");
    for (const bad of [{ expiresOn: "2027-13-01" }, { expiresOn: "2027-02-30" }, { expiresOn: "내일" }, { expiresOn: 20270101 }, {}]) {
      expect((await put(cookie, "gemini", { expectedVersion: 0, ...bad })).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await put(cookie, "gemini", { expiresOn: "2027-01-01" })).status).toBe(400);
    expect((await put(cookie, "nope", { expiresOn: "2027-01-01", expectedVersion: 0 })).status).toBe(404);

    expect(await (await put(cookie, "mail", { expiresOn: kstYmd(10), expectedVersion: 0 })).json()).toEqual({ expiresOn: kstYmd(10), version: 1 });
    expect((await put(cookie, "mail", { expiresOn: kstYmd(20), expectedVersion: 0 })).status).toBe(409);
    expect(find(await list(cookie), "mail")).toMatchObject({ expiresOn: kstYmd(10), status: "expiring", version: 1 });
    expect(find(await list(cookie), "mail").daysLeft).toBeGreaterThanOrEqual(9);

    expect(await (await put(cookie, "mail", { expiresOn: null, expectedVersion: 1 })).json()).toEqual({ expiresOn: null, version: 2 });
    const logs = await db.auditLog.findMany({ where: { action: "admin.infra.connection_expiry_update" }, orderBy: { createdAt: "asc" } });
    expect(logs).toHaveLength(2);
    expect(logs[0]).toMatchObject({ actorId: id, targetId: "mail", before: { expiresOn: null }, after: { expiresOn: kstYmd(10) } });
  });

  it("호출 기록: 정상 호출 시각, 인증 오류 시각·상태 코드. 오류 뒤 정상이면 상태가 돌아온다", async () => {
    const { cookie } = await adminCookie("SUPER_ADMIN");
    await recordConnectionResult(db, "nts_business_status", "auth_error", "http_401", new Date(Date.now() - 60_000));
    let c = find(await list(cookie), "nts_business_status");
    expect(c).toMatchObject({ status: "auth_error", lastAuthErrorCode: "http_401", lastOkAt: null });
    await recordConnectionResult(db, "nts_business_status", "ok");
    c = find(await list(cookie), "nts_business_status");
    expect(c.status).toBe("ok");
    expect(c.lastOkAt).toEqual(expect.any(String));
  });

  it("홈 요약 경고: 만료 30일·7일 이내와 인증 오류가 개수로 들어간다", async () => {
    const { cookie } = await adminCookie("SUPER_ADMIN");
    await put(cookie, "mail", { expiresOn: kstYmd(20), expectedVersion: 0 });
    await put(cookie, "payment_gateway", { expiresOn: kstYmd(3), expectedVersion: 0 });
    await put(cookie, "identity_verification", { expiresOn: kstYmd(-2), expectedVersion: 0 });
    await recordConnectionResult(db, "ftc_mail_order", "auth_error", "http_403");
    const sum = await (await summaryRoute(new Request(`${BASE}/api/admin/infra/summary`, { headers: { cookie } }))).json();
    expect(sum.warnings).toMatchObject({ expiring30: 1, expiring7: 2, authError: 1 });
    expect(sum.warnings.total).toBe(sum.warnings.capacity + sum.warnings.limitStopped + 4);
  });

  it("도우미 호출 결과가 gemini 연결 상태에 기록된다: 정상, 401은 인증 오류, 500은 기록 없음", async () => {
    const { seller } = await createSeller();
    const u = await createSellerUser(seller.id, "OWNER");
    const l = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
    if (!l.ok) throw new Error(l.reason);
    const ctx = { sellerId: seller.id, actorType: "SELLER_USER", actorId: u.id, isOwner: true, permissions: [] } as unknown as TenantContext;
    await db.assistantSetting.upsert({ where: { id: 1 }, create: { id: 1, enabled: true, model: "m", inputWonPerMTok: 1000, outputWonPerMTok: 1000 }, update: { enabled: true, model: "m", inputWonPerMTok: 1000, outputWonPerMTok: 1000 } });
    const a = await createAdmin("CS");
    await db.assistantDoc.create({ data: { title: "주문 취소 방법", body: "주문 관리에서 주문을 고른 뒤 취소 버튼을 누릅니다.", published: true, createdByAdminId: a.id, updatedByAdminId: a.id } });
    const Q = { question: "주문 취소 어떻게 해요?" };
    const KEY = () => "test-key";
    const row = () => db.externalConnection.findUnique({ where: { key: "gemini" } });

    await askAssistant(db, ctx, Q, { apiKey: KEY, generate: async () => { throw new GeminiError("gemini_http_500", false); } });
    expect(await row()).toBeNull();
    await askAssistant(db, ctx, Q, { apiKey: KEY, generate: async () => { throw new GeminiError("gemini_http_401", true); } });
    expect(await row()).toMatchObject({ lastAuthErrorCode: "http_401", lastOkAt: null });
    await askAssistant(db, ctx, Q, { apiKey: KEY, generate: async () => ({ text: "취소 버튼을 누릅니다", inputTokens: 10, outputTokens: 5 }) });
    expect((await row())?.lastOkAt).toBeInstanceOf(Date);
  });
});
