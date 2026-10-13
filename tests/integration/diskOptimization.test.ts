import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as statusRoute } from "../../app/api/admin/infra/disk-optimization/route";
import { PUT as autoRoute } from "../../app/api/admin/infra/disk-optimization/auto/route";
import { POST as previewRoute } from "../../app/api/admin/infra/disk-optimization/preview/route";
import { POST as executeRoute } from "../../app/api/admin/infra/disk-optimization/execute/route";
import { GET as jobRoute } from "../../app/api/admin/infra/disk-optimization/jobs/[id]/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { DISK_OPTIMIZATION_POLICY as policy } from "../../lib/server/ops/diskOptimization";
import { createAdmin, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => { await db.$disconnect(); await prisma.$disconnect(); });
const BASE = "http://localhost:3000", SOURCE = "disk_optimization_request", KEY = "diskOptimizationAutoEnabled";
const adminCookie = async (role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY" = "SUPER_ADMIN") => {
  const a = await createAdmin(role), session = await createAdminSession(db, a.id, {});
  return `lo_admin=${session.token}`;
};
const request = (path: string, cookie?: string, body?: unknown, method = "GET", origin = BASE) => new Request(`${BASE}/api/admin/infra/disk-optimization${path}`, { method, headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const fixed = { actionId: policy.actionId, policyVersion: policy.version };
const executeBody = (id = randomUUID()) => ({ ...fixed, idempotencyKey: id, candidateFingerprint: null, previewExpiresAt: null });

describe("미검증 테스트 서버 디스크 최적화 API", () => {
  it("최고관리자만 조회하고 앱FS를 호스트/최적화 성공으로 오인하지 않는다", async () => {
    expect((await statusRoute(request(""))).status).toBe(401);
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) {
      const cookie = await adminCookie(role);
      expect((await statusRoute(request("", cookie))).status).toBe(403);
      expect((await autoRoute(request("/auto", cookie, { enabled: false, expectedVersion: null }, "PUT"))).status).toBe(403);
      expect((await previewRoute(request("/preview", cookie, fixed, "POST"))).status).toBe(403);
      expect((await executeRoute(request("/execute", cookie, executeBody(), "POST"))).status).toBe(403);
    }
    const res = await statusRoute(request("", await adminCookie()));
    expect(res.status).toBe(200); expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ readiness: { autoEnableAllowed: false, manualExecuteAllowed: false }, serverDisk: { state: "unavailable", totalBytes: null }, appFilesystem: { scope: "APP_FILESYSTEM_ONLY", verifiedAsHost: false }, auto: { enabled: false, effectiveEnabled: false }, latestActualJob: null, lastOptimizedAt: null, nextRunAt: null });
  });
  it("CSRF가 차단되면 설정/요청 감사에 쓰지 않는다", async () => {
    const cookie = await adminCookie();
    expect((await autoRoute(request("/auto", cookie, { enabled: true, expectedVersion: null }, "PUT", "http://other.example"))).status).toBe(403);
    expect((await previewRoute(request("/preview", cookie, fixed, "POST", "http://other.example"))).status).toBe(403);
    expect((await executeRoute(request("/execute", cookie, executeBody(), "POST", "http://other.example"))).status).toBe(403);
    expect(await db.platformPolicy.count()).toBe(0);
    expect(await db.opsEvent.count({ where: { source: SOURCE } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: { startsWith: "admin.infra.disk_" } } })).toBe(0);
  });
  it("자동 켜기를 거부하고 기본 끄기는 멱등이며 유효 버전만 기존 설정을 끈다", async () => {
    const cookie = await adminCookie();
    const enable = await autoRoute(request("/auto", cookie, { enabled: true, expectedVersion: null }, "PUT"));
    expect(enable.status).toBe(503);
    expect(await db.platformPolicy.count({ where: { key: KEY } })).toBe(0);
    expect(await db.auditLog.count({ where: { action: "admin.infra.disk_auto_rejected" } })).toBe(1);
    for (let i = 0; i < 2; i++) expect((await autoRoute(request("/auto", cookie, { enabled: false, expectedVersion: null }, "PUT"))).status).toBe(200);
    const row = await db.platformPolicy.create({ data: { key: KEY, intValue: 1, updatedAt: new Date("2026-10-01T00:00:00Z") } });
    const responses = await Promise.all([0, 1].map(() => autoRoute(request("/auto", cookie, { enabled: false, expectedVersion: row.updatedAt.toISOString() }, "PUT"))));
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.platformPolicy.findUniqueOrThrow({ where: { key: KEY } })).intValue).toBe(0);
    expect(await db.auditLog.count({ where: { action: "admin.infra.disk_auto_disabled" } })).toBe(1);
  });
  it("preview 원천 부재는 빈 성공 목록이 아니며 실행 동시 요청은 거부 추적 하나만 만든다", async () => {
    const cookie = await adminCookie();
    const preview = await previewRoute(request("/preview", cookie, fixed, "POST"));
    expect(preview.status).toBe(503);
    expect(await preview.json()).toMatchObject({ candidates: null, candidateFingerprint: null, expiresAt: null, job: null });
    const body = executeBody();
    const results = await Promise.all(Array.from({ length: 6 }, () => executeRoute(request("/execute", cookie, body, "POST"))));
    expect(results.every((r) => r.status === 503)).toBe(true);
    const views = await Promise.all(results.map((r) => r.json()));
    expect(views.filter((v) => !v.replayed)).toHaveLength(1);
    expect(views.every((v) => v.requestId === body.idempotencyKey && v.job === null)).toBe(true);
    expect(await db.opsEvent.count({ where: { source: SOURCE } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "admin.infra.disk_execute_rejected" } })).toBe(1);
    const job = await jobRoute(request(`/jobs/${body.idempotencyKey}`, cookie), { params: Promise.resolve({ id: body.idempotencyKey }) });
    expect(job.status).toBe(404); expect(await job.json()).toMatchObject({ job: null });
  });
  it("같은 키 다른 후보는 충돌하고 만료/임의경로/명령/env는 요청 추적을 만들지 않는다", async () => {
    const cookie = await adminCookie(), body = executeBody();
    expect((await executeRoute(request("/execute", cookie, body, "POST"))).status).toBe(503);
    const changed = { ...body, candidateFingerprint: "a".repeat(64), previewExpiresAt: new Date(Date.now() + 600_000).toISOString() };
    expect((await executeRoute(request("/execute", cookie, changed, "POST"))).status).toBe(409);
    const expired = { ...changed, idempotencyKey: randomUUID(), previewExpiresAt: "2026-01-01T00:00:00.000Z" };
    expect((await executeRoute(request("/execute", cookie, expired, "POST"))).status).toBe(409);
    for (const extra of [{ path: "/" }, { command: "docker system prune" }, { env: {} }, { actionId: "CUSTOM" }]) {
      expect((await executeRoute(request("/execute", cookie, { ...executeBody(), ...extra }, "POST"))).status).toBe(400);
    }
    expect(await db.opsEvent.count({ where: { source: SOURCE } })).toBe(1);
  });
  it("원천 미검증 event의 성공 주장을 실제 job/마지막 최적화로 쓰지 않는다", async () => {
    const cookie = await adminCookie(), id = randomUUID();
    await db.opsEvent.create({ data: { source: SOURCE, eventId: id, kind: "info", key: "OBS_TEST", severity: "info", message: "fixture", occurredAt: new Date(), detail: { state: "SUCCEEDED", lastOptimizedAt: "2026-10-01T00:00:00Z" } } });
    const res = await statusRoute(request("", cookie));
    expect(await res.json()).toMatchObject({ latestActualJob: null, lastOptimizedAt: null });
    expect((await executeRoute(request("/execute", cookie, executeBody(id), "POST"))).status).toBe(409);
  });
});
