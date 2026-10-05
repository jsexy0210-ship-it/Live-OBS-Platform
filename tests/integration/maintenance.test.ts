import type { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as adminGet, PUT as adminPut } from "../../app/api/admin/settings/maintenance/route";
import { GET as publicGet } from "../../app/api/maintenance/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { CACHE_MS, cachedMaintenance, clearMaintenanceCache, MAINTENANCE_NOTICE, MAINTENANCE_NOTICE_FORMAL } from "../../lib/server/maintenance/service";
import { proxy } from "../../proxy";
import { createAdmin, db, resetDb } from "./helpers";

// 점검 모드(MA-083 · AU-010): 권한(보기 전 역할, 바꾸기 최고관리자만), 검사, version 충돌·동시 변경, 로그 추적,
// 공개 상태(예정·진행), proxy가 막는 경로와 여는 경로(마스터·오버레이·결제사 알림·작업·상태 확인), 기본 문구 말투, 5초 기억·실패 시 열기.
beforeEach(async () => {
  await resetDb();
  clearMaintenanceCache();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function adminCookie(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, name: a.name, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const req = (path: string, cookie: string, method = "GET", body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
const put = async (cookie: string, body: unknown) => json(await adminPut(req("/api/admin/settings/maintenance", cookie, "PUT", body)));
const ON = { enabled: true, message: "10시부터 11시까지 점검합니다.", endsAt: new Date(Date.now() + 3600_000).toISOString() };

async function hit(path: string) {
  const res = await proxy(new NextRequest(BASE + path));
  if (res.headers.get("x-middleware-next") === "1") return { kind: "pass" as const };
  const rewrite = res.headers.get("x-middleware-rewrite");
  if (rewrite) return { kind: "rewrite" as const, to: new URL(rewrite).pathname };
  return { kind: "blocked" as const, status: res.status, body: await res.json(), retryAfter: res.headers.get("retry-after") };
}

describe("점검 모드 설정", () => {
  it("보기는 모든 역할, 바꾸기는 최고관리자만. 처음엔 꺼져 있다. 바꾸면 로그 추적에 전후가 남는다", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) {
      const a = await adminCookie(role);
      expect(await json(await adminGet(req("/api/admin/settings/maintenance", a.cookie)))).toMatchObject({
        status: 200,
        body: { maintenance: { enabled: false, active: false, scheduled: false, message: "", version: 0, updatedAt: null, updatedByAdminName: null } },
      });
      expect((await put(a.cookie, { ...ON, expectedVersion: 0 })).status).toBe(403);
    }
    expect((await json(await adminGet(req("/api/admin/settings/maintenance", "")))).status).toBe(401);
    const r = await put(su.cookie, { ...ON, expectedVersion: 0 });
    expect(r).toMatchObject({ status: 200, body: { maintenance: { enabled: true, active: true, message: ON.message, endsAt: ON.endsAt, version: 1, updatedByAdminName: su.name } } });
    const logs = await db.auditLog.findMany({ where: { action: "platform.maintenance.update" } });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actorId: su.id, before: { enabled: false, message: "" }, after: { enabled: true, message: ON.message } });
  });

  it("켜려면 안내 문구가 있어야 하고, 종료 예정은 시작보다 뒤. 옛 version은 409, 같은 version 동시 변경은 하나만", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    expect((await put(su.cookie, { enabled: true, message: "", expectedVersion: 0 })).body.error).toBe("invalid_message");
    expect((await put(su.cookie, { enabled: true, message: "가".repeat(501), expectedVersion: 0 })).body.error).toBe("invalid_message");
    const start = new Date(Date.now() + 3600_000);
    expect((await put(su.cookie, { ...ON, startsAt: start.toISOString(), endsAt: new Date(start.getTime() - 1).toISOString(), expectedVersion: 0 })).body.error).toBe("invalid_time");
    expect((await put(su.cookie, { ...ON, endsAt: new Date(Date.now() - 1000).toISOString(), expectedVersion: 0 })).body.error).toBe("invalid_time");
    expect((await put(su.cookie, { ...ON, startsAt: "내일", expectedVersion: 0 })).body.error).toBe("invalid_time");
    // 끄는 것은 문구 없이도 된다
    expect((await put(su.cookie, { enabled: false, expectedVersion: 0 })).body.maintenance).toMatchObject({ enabled: false, version: 1 });
    expect(await put(su.cookie, { ...ON, expectedVersion: 0 })).toMatchObject({ status: 409, body: { error: "version_conflict", currentVersion: 1 } });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => put(su.cookie, i % 2 ? { enabled: false, expectedVersion: 1 } : { ...ON, expectedVersion: 1 })));
    expect(rs.map((x) => x.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect(await db.auditLog.count({ where: { action: "platform.maintenance.update" } })).toBe(2);
  });

  it("공개 상태: 꺼짐 → 예정(시작 전) → 진행 중. 꺼져 있으면 문구·시각을 주지 않는다", async () => {
    const su = await adminCookie("SUPER_ADMIN");
    expect(await json(await publicGet())).toEqual({ status: 200, body: { active: false, scheduled: false, message: "", startsAt: null, endsAt: null } });
    const startsAt = new Date(Date.now() + 3600_000).toISOString();
    const endsAt = new Date(Date.now() + 7200_000).toISOString();
    await put(su.cookie, { enabled: true, message: "예정 점검", startsAt, endsAt, expectedVersion: 0 });
    expect((await json(await publicGet())).body).toEqual({ active: false, scheduled: true, message: "예정 점검", startsAt, endsAt });
    await db.platformMaintenance.update({ where: { id: 1 }, data: { startsAt: new Date(Date.now() - 1000) } });
    expect((await json(await publicGet())).body).toMatchObject({ active: true, scheduled: false, message: "예정 점검" });
    await put(su.cookie, { enabled: false, message: "남은 문구", startsAt, expectedVersion: 1 });
    expect((await json(await publicGet())).body).toEqual({ active: false, scheduled: false, message: "", startsAt: null, endsAt: null });
  });
});

describe("점검 중 막기(proxy)", () => {
  const BLOCKED_API = ["/api/seller/me", "/api/seller/orders/abc", "/api/seller-signup/apply", "/api/shop/shop-1/cart", "/api/automation/purchase", "/api/automation/reconnect"];
  const BLOCKED_PAGE = ["/seller", "/seller/orders", "/shop/shop-1", "/shop/shop-1/products/x"];
  const OPEN = ["/api/admin/me", "/admin/dashboard", "/api/overlay/tok/state", "/overlay/tok", "/api/payments/nicepay/return", "/api/automation/jobs", "/api/health", "/api/notices", "/api/maintenance", "/api/plans", "/", "/pricing", "/sellers", "/shopping"];

  it("꺼져 있으면 모두 통과. 켜면 파트너스·구매자·가입 API는 503, 화면은 /maintenance, 마스터·오버레이·결제사 알림·작업·공개 정보는 그대로", async () => {
    for (const path of [...BLOCKED_API, ...BLOCKED_PAGE, ...OPEN]) expect(await hit(path), path).toEqual({ kind: "pass" });
    const su = await adminCookie("SUPER_ADMIN");
    await put(su.cookie, { ...ON, expectedVersion: 0 });
    for (const path of BLOCKED_API) expect(await hit(path), path).toEqual({ kind: "blocked", status: 503, retryAfter: "300", body: { error: "maintenance", message: ON.message, endsAt: ON.endsAt } });
    for (const path of BLOCKED_PAGE) expect(await hit(path), path).toEqual({ kind: "rewrite", to: "/maintenance" });
    for (const path of OPEN) expect(await hit(path), path).toEqual({ kind: "pass" });
  });

  it("안내 문구가 없으면 기본 문구: 파트너스 관리자 API는 합니다체, 구매자·가입 신청은 해요체. 시작 전 예정 점검은 막지 않는다", async () => {
    await db.platformMaintenance.create({ data: { id: 1, enabled: true, message: "", startsAt: new Date(Date.now() + 3600_000) } });
    expect(await hit("/api/seller/me")).toEqual({ kind: "pass" });
    clearMaintenanceCache();
    await db.platformMaintenance.update({ where: { id: 1 }, data: { startsAt: null } });
    for (const path of ["/api/seller/me", "/api/automation/purchase"]) expect(((await hit(path)) as { body: { message: string } }).body.message).toBe(MAINTENANCE_NOTICE_FORMAL);
    for (const path of ["/api/shop/a/cart", "/api/seller-signup/apply"]) expect(((await hit(path)) as { body: { message: string } }).body.message).toBe(MAINTENANCE_NOTICE);
  });

  it(`상태는 ${CACHE_MS / 1000}초 기억한다(마스터에서 바꾸면 그 서버는 바로 반영). DB를 못 읽으면 막지 않는다`, async () => {
    const t = Date.now();
    expect(await cachedMaintenance(db, t)).toMatchObject({ enabled: false });
    await db.platformMaintenance.create({ data: { id: 1, enabled: true, message: "x" } });
    expect(await cachedMaintenance(db, t + CACHE_MS - 1)).toMatchObject({ enabled: false });
    expect(await cachedMaintenance(db, t + CACHE_MS)).toMatchObject({ enabled: true });
    // 바꾸기 API는 기억을 지운다
    const su = await adminCookie("SUPER_ADMIN");
    await put(su.cookie, { enabled: false, expectedVersion: 0 });
    expect(await hit("/api/seller/me")).toEqual({ kind: "pass" });
    clearMaintenanceCache();
    const broken = { platformMaintenance: { findUnique: () => Promise.reject(new Error("db down")) } } as unknown as PrismaClient;
    expect(await cachedMaintenance(broken)).toBeNull();
  });
});
