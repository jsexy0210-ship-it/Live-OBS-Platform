import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as statusRoute } from "../../app/api/admin/infra/status/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { collectInfraSnapshot, infraSignals, type InfraMeasure } from "../../lib/server/ops/infra";
import { createAdmin, db, resetDb } from "./helpers";

beforeEach(async () => {
  vi.unstubAllEnvs();
  await resetDb();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await prisma.$disconnect();
});

const adminCookie = async (role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") => {
  const admin = await createAdmin(role);
  const s = await createAdminSession(db, admin.id, {});
  return `lo_admin=${s.token}`;
};
const status = (cookie?: string, q = "") => statusRoute(new Request(`http://localhost:3000/api/admin/infra/status${q}`, { headers: cookie ? { cookie } : {} }));

const base: InfraMeasure = {
  takenAt: new Date("2026-10-06T00:00:00Z"), instance: "x",
  diskTotalBytes: 100, diskUsedBytes: 10, memTotalBytes: 100, memUsedBytes: 10, cpuCount: 2, load1: 0.1,
  dbSizeBytes: 1, dbConnections: 1, dbMaxConnections: 100, backupLastAt: null, backupCount: null, backupBytes: null,
};

describe("인프라 용량", () => {
  it("기준 초과 신호: 디스크·메모리·CPU·DB 연결 80% 경고·90% 위험, 백업 36시간 경고·72시간 위험. 못 잰 값은 신호를 내지 않는다", () => {
    expect(infraSignals(base)).toEqual([]);
    expect(infraSignals({ ...base, diskUsedBytes: 80 })).toEqual([{ key: "disk", level: "warning", value: 80, threshold: 80 }]);
    expect(infraSignals({ ...base, diskUsedBytes: 91, memUsedBytes: 85, load1: 1.8, dbConnections: 85 }).map((s) => [s.key, s.level])).toEqual([["disk", "critical"], ["memory", "warning"], ["cpu", "critical"], ["dbConnections", "warning"]]);
    expect(infraSignals({ ...base, diskTotalBytes: null, diskUsedBytes: null })).toEqual([]);
    expect(infraSignals({ ...base, backupLastAt: new Date("2026-10-04T12:00:00Z") })).toEqual([{ key: "backupStale", level: "warning", value: 36, threshold: 36 }]);
    expect(infraSignals({ ...base, backupLastAt: new Date("2026-10-03T00:00:00Z") })).toEqual([{ key: "backupStale", level: "critical", value: 72, threshold: 36 }]);
    expect(infraSignals({ ...base, backupLastAt: new Date("2026-10-05T12:00:00Z") })).toEqual([]);
  });

  it("스냅숏을 저장하고 35일 지난 것은 지운다", async () => {
    const now = new Date();
    await db.infraSnapshot.create({ data: { takenAt: new Date(now.getTime() - 36 * 86_400_000), instance: "old" } });
    await db.infraSnapshot.create({ data: { takenAt: new Date(now.getTime() - 2 * 86_400_000), instance: "keep" } });
    expect(await collectInfraSnapshot(db, now)).toBe(1);
    const rows = await db.infraSnapshot.findMany({ orderBy: { takenAt: "asc" } });
    expect(rows.map((r) => r.instance)).not.toContain("old");
    expect(rows).toHaveLength(2);
    const fresh = rows[1];
    expect(Number(fresh.diskTotalBytes)).toBeGreaterThan(0);
    expect(Number(fresh.dbSizeBytes)).toBeGreaterThan(0);
    expect(fresh.dbConnections).toBeGreaterThan(0);
    expect(fresh.backupLastAt).toBeNull();
  });

  it("백업 폴더(OPS_BACKUP_DIR)가 있으면 마지막 백업 시각·개수·용량을 잰다", async () => {
    const dir = mkdtempSync(join(tmpdir(), "infra-"));
    try {
      writeFileSync(join(dir, "obs-1.dump"), "aaaa");
      writeFileSync(join(dir, "obs-2.dump"), "bb");
      writeFileSync(join(dir, "obs-3.dump.part"), "zzzz");
      const t = new Date("2026-10-05T03:00:00Z");
      utimesSync(join(dir, "obs-2.dump"), t, t);
      vi.stubEnv("OPS_BACKUP_DIR", dir);
      const cookie = await adminCookie("SUPER_ADMIN");
      const body = await (await status(cookie)).json();
      expect(body.current.backup).toEqual({ lastAt: expect.any(String), count: 2, totalBytes: 6 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("조회 API: 최고관리자만. 다른 역할·비로그인은 거절, 응답에 지금 값·기준·신호·스냅숏이 있고 no-store", async () => {
    expect((await status()).status).toBe(401);
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) expect((await status(await adminCookie(role))).status).toBe(403);
    await collectInfraSnapshot(db, new Date());
    const res = await status(await adminCookie("SUPER_ADMIN"), "?hours=24");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const body = await res.json();
    expect(body.thresholds).toEqual({ warnPct: 80, criticalPct: 90, backupMaxAgeHours: 36 });
    expect(body.current.disk.totalBytes).toBeGreaterThan(0);
    expect(body.current.backup).toEqual({ lastAt: null, count: null, totalBytes: null });
    expect(Array.isArray(body.signals)).toBe(true);
    expect(body.snapshots).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/password|secret|token/i);
  });
});
