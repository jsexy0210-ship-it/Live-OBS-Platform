import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as metricsRoute } from "../../app/api/admin/ops/metrics/route";
import { POST as eventsRoute } from "../../app/api/internal/ops/events/route";
import { GET as healthRoute } from "../../app/api/health/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { resetShutdownForTests, retireInstance, runScheduledJobs, type ScheduledJob } from "../../lib/server/jobs/scheduler";
import { markInstanceRetired, opsInstanceName, opsMetrics, purgeRetiredHeartbeats, recordHeartbeat } from "../../lib/server/ops/metrics";
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

const BASE = "http://localhost:3000";
const TOKEN = "ops-ingest-token-0123456789abcdef-xyz";
const adminCookie = async (role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") => {
  const admin = await createAdmin(role);
  const s = await createAdminSession(db, admin.id, {});
  return `lo_admin=${s.token}`;
};
const metrics = (cookie?: string) => metricsRoute(new Request(`${BASE}/api/admin/ops/metrics`, { headers: cookie ? { cookie } : {} }));
const ingest = (body: unknown, token?: string) =>
  eventsRoute(new Request(`${BASE}/api/internal/ops/events`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }));
const ev = (over: Record<string, unknown> = {}) => ({ source: "monitor", eventId: "e1", kind: "incident_open", key: "health", severity: "critical", message: "앱 응답 없음", occurredAt: "2026-10-04T01:00:00Z", ...over });

describe("정기 실행 heartbeat", () => {
  it("작업마다 결과와 마지막 실행·성공 시각을 남기고, 루프 자체도 scheduler.tick으로 남긴다. 실패가 이어져도 마지막 성공 시각은 그대로다", async () => {
    vi.stubEnv("OPS_INSTANCE_NAME", "web-1");
    let fail = false;
    const jobs: ScheduledJob[] = [{ name: "test.job", run: async () => { if (fail) throw new Error("boom"); return 1; } }];
    const t1 = new Date("2026-10-04T00:00:00Z");
    await runScheduledJobs(db, t1, jobs);
    fail = true;
    const t2 = new Date("2026-10-04T01:00:00Z");
    await runScheduledJobs(db, t2, jobs);
    const rows = await db.opsHeartbeat.findMany({ orderBy: { job: "asc" } });
    expect(rows.map((r) => [r.instance, r.job, r.lastStatus])).toEqual([
      ["web-1", "scheduler.tick", "failed"],
      ["web-1", "test.job", "failed"],
    ]);
    const job = rows.find((r) => r.job === "test.job")!;
    expect(job.lastRunAt).toEqual(t2);
    expect(job.lastOkAt).toEqual(t1);
    expect(job.lastError).toBe("boom");
    fail = false;
    await runScheduledJobs(db, new Date("2026-10-04T02:00:00Z"), jobs);
    expect(await db.opsHeartbeat.findUniqueOrThrow({ where: { instance_job: { instance: "web-1", job: "test.job" } } })).toMatchObject({ lastStatus: "done", lastError: null });
    expect(opsInstanceName()).toBe("web-1");
  });
});

describe("heartbeat 보완(Codex)", () => {
  it("건너뛴 실행(다른 인스턴스가 잠금)은 마지막 실행 시각만 남기고 상태·성공 시각·오류는 그대로 둔다", async () => {
    const t = (h: number) => new Date(Date.UTC(2026, 9, 4, h));
    await recordHeartbeat(db, "job", "done", t(0), undefined, "web-1");
    await recordHeartbeat(db, "job", "failed", t(1), "boom", "web-1");
    await recordHeartbeat(db, "job", "skipped", t(2), undefined, "web-1");
    expect(await db.opsHeartbeat.findUniqueOrThrow({ where: { instance_job: { instance: "web-1", job: "job" } } })).toMatchObject({
      lastRunAt: t(2), lastStatus: "failed", lastError: "boom", lastOkAt: t(0),
    });
    // 처음부터 건너뛴 작업은 성공 시각이 없다
    await recordHeartbeat(db, "other", "skipped", t(3), undefined, "web-1");
    expect(await db.opsHeartbeat.findUniqueOrThrow({ where: { instance_job: { instance: "web-1", job: "other" } } })).toMatchObject({ lastStatus: "skipped", lastOkAt: null });
  });

  it("종료 표시(정상 종료 신호)가 없는 인스턴스는 아무리 오래돼도 heartbeats에 남고, 표시가 있는 인스턴스만 retiredHeartbeats로 가며 표시 7일 뒤 지워진다. 다시 실행하면 표시가 풀린다", async () => {
    const now = new Date("2026-10-10T00:00:00Z");
    const ago = (ms: number) => new Date(now.getTime() - ms);
    await recordHeartbeat(db, "scheduler.tick", "done", ago(3600_000), undefined, "web-new");
    // heartbeat만 고장 난 살아 있는 인스턴스(10일째 기록 없음, 종료 표시 없음)
    await recordHeartbeat(db, "scheduler.tick", "done", ago(10 * 86_400_000), undefined, "web-stuck");
    await recordHeartbeat(db, "scheduler.tick", "done", ago(9 * 86_400_000), undefined, "web-gone");
    await recordHeartbeat(db, "job.a", "done", ago(9 * 86_400_000), undefined, "web-gone");
    await recordHeartbeat(db, "scheduler.tick", "done", ago(2 * 86_400_000), undefined, "web-old");
    expect(await markInstanceRetired(db, ago(8 * 86_400_000), "web-gone")).toBe(2);
    expect(await markInstanceRetired(db, ago(86_400_000), "web-old")).toBe(1);
    const m = await opsMetrics(db);
    expect(m.heartbeats.map((h) => h.instance).sort()).toEqual(["web-new", "web-stuck"]);
    expect(m.retiredHeartbeats.map((h) => h.instance).sort()).toEqual(["web-gone", "web-gone", "web-old"]);
    // 표시 뒤 7일 지난 web-gone만 지운다(종료 표시 없는 web-stuck은 오래돼도 남는다)
    expect(await purgeRetiredHeartbeats(db, now)).toBe(2);
    expect((await db.opsHeartbeat.findMany()).map((h) => h.instance).sort()).toEqual(["web-new", "web-old", "web-stuck"]);
    // 같은 이름으로 다시 실행하면 살아 있는 인스턴스로 돌아온다
    await recordHeartbeat(db, "scheduler.tick", "skipped", now, undefined, "web-old");
    expect((await opsMetrics(db)).heartbeats.map((h) => h.instance).sort()).toEqual(["web-new", "web-old", "web-stuck"]);
    expect((await import("../../lib/server/jobs/scheduler")).SCHEDULED_JOBS.map((j) => j.name)).toContain("ops_heartbeat.purge_retired");
  });

  it("종료 처리 중에 진행 중이던 실행이 끝나도 종료 표시가 되돌아가지 않고, 종료 뒤에는 새 실행·heartbeat를 쓰지 않는다", async () => {
    vi.stubEnv("OPS_INSTANCE_NAME", "web-1");
    try {
      // 앞선 실행으로 heartbeat 행이 있다
      await runScheduledJobs(db, new Date(), [{ name: "slow", run: async () => 0 }]);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let entered!: () => void;
      const started = new Promise<void>((r) => (entered = r));
      const running = runScheduledJobs(db, new Date(), [{ name: "slow", run: async () => { entered(); await gate; return 1; } }]);
      await started;
      const retiring = retireInstance(db, 2000);
      setTimeout(release, 100);
      await Promise.all([running, retiring]);
      const rows = await db.opsHeartbeat.findMany({ where: { instance: "web-1" } });
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.retiredAt, r.job).not.toBeNull();
      // 종료 뒤에는 돌지 않는다
      expect(await runScheduledJobs(db, new Date(), [{ name: "slow", run: async () => 1 }])).toEqual([]);
      expect((await db.opsHeartbeat.findMany({ where: { instance: "web-1" } })).every((r) => r.retiredAt !== null)).toBe(true);
    } finally {
      resetShutdownForTests();
    }
  });

  it("같은 occurredAt의 열기·닫기는 늦게 들어온 쪽으로 정한다(한 번에 보내도, 따로 보내도)", async () => {
    vi.stubEnv("OPS_INGEST_TOKEN", TOKEN);
    const at = "2026-10-04T03:00:00Z";
    await ingest({ events: [ev({ eventId: "a1", key: "health", kind: "incident_open", occurredAt: at }), ev({ eventId: "a2", key: "health", kind: "incident_close", occurredAt: at })] }, TOKEN);
    await ingest({ events: [ev({ eventId: "b1", key: "cert", kind: "incident_close", occurredAt: at })] }, TOKEN);
    await ingest({ events: [ev({ eventId: "b2", key: "cert", kind: "incident_open", occurredAt: at })] }, TOKEN);
    for (let i = 0; i < 5; i++) expect((await opsMetrics(db)).incidents.open.map((e) => e.key)).toEqual(["cert"]);
  });
});

describe("운영 지표 GET /api/admin/ops/metrics", () => {
  it("최고관리자만 본다(운영·CS·조회 전용 403, 로그인 없음 401). DB 지연·연결 수·heartbeat·큐(not_measured)·열린 사건을 준다. 공개 health에는 없다", async () => {
    expect((await metrics()).status).toBe(401);
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) expect((await metrics(await adminCookie(role))).status, role).toBe(403);
    vi.stubEnv("OPS_INGEST_TOKEN", TOKEN);
    await ingest({ events: [ev(), ev({ eventId: "e2", key: "cert", kind: "incident_open", occurredAt: "2026-10-04T01:01:00Z" }), ev({ eventId: "e3", kind: "incident_close", occurredAt: "2026-10-04T01:05:00Z", message: "복구" })] }, TOKEN);
    await runScheduledJobs(db, new Date(), [{ name: "test.ok", run: async () => 0 }]);
    const r = await metrics(await adminCookie("SUPER_ADMIN"));
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.db.latencyMs).toEqual(expect.any(Number));
    expect(body.db.connections.total).toBeGreaterThanOrEqual(1);
    expect(body.db.connections.max).toBeGreaterThan(0);
    expect(body.queueBacklog).toBe("not_measured");
    expect(body.heartbeats.map((h: { job: string }) => h.job).sort()).toEqual(["scheduler.tick", "test.ok"]);
    // health는 닫혔고 cert만 열려 있다
    expect(body.incidents.open.map((e: { key: string }) => e.key)).toEqual(["cert"]);
    expect(body.incidents.recent).toHaveLength(3);
    const health = await (await healthRoute()).json();
    expect(JSON.stringify(health)).not.toMatch(/connections|heartbeats|incidents/);
  });
});

describe("수집기 사건 기록 POST /api/internal/ops/events", () => {
  it("토큰이 설정되지 않으면 503, 틀리거나 없으면 401로 저장하지 않는다", async () => {
    expect((await ingest({ events: [ev()] }, TOKEN)).status).toBe(503);
    vi.stubEnv("OPS_INGEST_TOKEN", "short");
    expect((await ingest({ events: [ev()] }, "short")).status).toBe(503);
    vi.stubEnv("OPS_INGEST_TOKEN", TOKEN);
    expect((await ingest({ events: [ev()] })).status).toBe(401);
    expect((await ingest({ events: [ev()] }, `${TOKEN}x`)).status).toBe(401);
    expect(await db.opsEvent.count()).toBe(0);
  });

  it("같은 source·eventId는 한 번만 저장하고(재전송 안전), 형식이 틀리면 전체를 거부한다", async () => {
    vi.stubEnv("OPS_INGEST_TOKEN", TOKEN);
    const first = await ingest({ events: [ev(), ev({ eventId: "e2" })] }, TOKEN);
    expect(await first.json()).toEqual({ stored: 2 });
    expect(await (await ingest({ events: [ev(), ev({ eventId: "e3" })] }, TOKEN)).json()).toEqual({ stored: 1 });
    expect(await db.opsEvent.count()).toBe(3);
    for (const bad of [{}, { events: [] }, { events: [ev({ kind: "delete_all" })] }, { events: [ev({ occurredAt: "nope" })] }, { events: [ev(), ev({ eventId: "" })] }, { events: Array.from({ length: 51 }, (_, i) => ev({ eventId: `b${i}` })) }]) {
      expect((await ingest(bad, TOKEN)).status, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect(await db.opsEvent.count()).toBe(3);
  });
});
