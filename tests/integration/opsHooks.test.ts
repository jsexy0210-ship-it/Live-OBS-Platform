import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as metricsRoute } from "../../app/api/admin/ops/metrics/route";
import { POST as eventsRoute } from "../../app/api/internal/ops/events/route";
import { GET as healthRoute } from "../../app/api/health/route";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { registerUntilDone, resetShutdownForTests, retireInstance, runScheduledJobs, type ScheduledJob } from "../../lib/server/jobs/scheduler";
import { markInstanceRetired, opsInstanceName, opsMetrics, purgeOldOpsEvents, purgeRetiredHeartbeats, recordHeartbeat, registerInstance } from "../../lib/server/ops/metrics";
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
// 사건 시각은 지금 기준(받은 시각보다 5분 넘게 미래면 거부)
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ev = (over: Record<string, unknown> = {}) => ({ source: "monitor", eventId: "e1", kind: "incident_open", key: "health", severity: "critical", message: "앱 응답 없음", occurredAt: ago(60), ...over });

describe("정기 실행 heartbeat", () => {
  it("작업마다 결과와 마지막 실행·성공 시각을 남기고, 루프 자체도 scheduler.tick으로 남긴다. 실패가 이어져도 마지막 성공 시각은 그대로다", async () => {
    vi.stubEnv("OPS_INSTANCE_NAME", "web-1");
    const gen = await registerInstance(db);
    let fail = false;
    const jobs: ScheduledJob[] = [{ name: "test.job", run: async () => { if (fail) throw new Error("boom"); return 1; } }];
    const t1 = new Date("2026-10-04T00:00:00Z");
    await runScheduledJobs(db, t1, jobs);
    fail = true;
    const t2 = new Date("2026-10-04T01:00:00Z");
    await runScheduledJobs(db, t2, jobs);
    const rows = await db.opsHeartbeat.findMany({ orderBy: { job: "asc" } });
    expect(rows.map((r) => [r.instance, r.generation, r.job, r.lastStatus])).toEqual([
      ["web-1", gen, "scheduler.tick", "failed"],
      ["web-1", gen, "test.job", "failed"],
    ]);
    const job = rows.find((r) => r.job === "test.job")!;
    expect(job.lastRunAt).toEqual(t2);
    expect(job.lastOkAt).toEqual(t1);
    expect(job.lastError).toBe("boom");
    fail = false;
    await runScheduledJobs(db, new Date("2026-10-04T02:00:00Z"), jobs);
    expect(await db.opsHeartbeat.findUniqueOrThrow({ where: { instance_generation_job: { instance: "web-1", generation: gen, job: "test.job" } } })).toMatchObject({ lastStatus: "done", lastError: null });
    expect(opsInstanceName()).toBe("web-1");
  });

  it("등록하지 않은 프로세스는 heartbeat를 쓰지 않는다", async () => {
    expect(await recordHeartbeat(db, "job", "done", new Date(), undefined, "web-none", "never-registered")).toBe(0);
    expect(await db.opsHeartbeat.count()).toBe(0);
  });
});

describe("heartbeat 보완(Codex)", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 9, 4, 0, m));
  const live = async () => (await opsMetrics(db)).heartbeats.map((h) => `${h.instance}:${h.job}`).sort();
  const retired = async () => (await opsMetrics(db)).retiredHeartbeats.map((h) => `${h.instance}:${h.job}`).sort();

  it("건너뛴 실행(다른 인스턴스가 잠금)은 마지막 실행 시각만 남기고 상태·성공 시각·오류는 그대로 둔다", async () => {
    const gen = await registerInstance(db, "web-1");
    await recordHeartbeat(db, "job", "done", t(0), undefined, "web-1", gen);
    await recordHeartbeat(db, "job", "failed", t(1), "boom", "web-1", gen);
    await recordHeartbeat(db, "job", "skipped", t(2), undefined, "web-1", gen);
    const row = await db.opsHeartbeat.findUniqueOrThrow({ where: { instance_generation_job: { instance: "web-1", generation: gen, job: "job" } } });
    expect(row).toMatchObject({ lastStatus: "failed", lastError: "boom", lastOkAt: t(0), lastRunAt: t(2) });
    // 처음부터 건너뛴 작업은 상태 skipped, 성공 시각 없음
    await recordHeartbeat(db, "other", "skipped", t(3), undefined, "web-1", gen);
    expect(await db.opsHeartbeat.findUniqueOrThrow({ where: { instance_generation_job: { instance: "web-1", generation: gen, job: "other" } } })).toMatchObject({ lastStatus: "skipped", lastOkAt: null });
  });

  it("종료 표시(정상 종료 신호)가 없는 인스턴스는 아무리 오래돼도 heartbeats에 남고, 표시가 있는 인스턴스만 retiredHeartbeats로 가며 표시 7일 뒤 지워진다. 늦게 도착한 heartbeat는 표시를 풀지 못하고, 새로 시작해 등록하면 풀린다", async () => {
    const now = new Date();
    const ago = (ms: number) => new Date(now.getTime() - ms);
    const gens: Record<string, string> = {};
    for (const name of ["web-new", "web-stuck", "web-gone", "web-old"]) gens[name] = await registerInstance(db, name);
    await recordHeartbeat(db, "scheduler.tick", "done", ago(3600_000), undefined, "web-new", gens["web-new"]);
    // 10일째 기록이 없지만 종료 표시도 없다(heartbeat만 고장 난 인스턴스일 수 있다)
    await recordHeartbeat(db, "scheduler.tick", "done", ago(10 * 86_400_000), undefined, "web-stuck", gens["web-stuck"]);
    await recordHeartbeat(db, "scheduler.tick", "done", ago(9 * 86_400_000), undefined, "web-gone", gens["web-gone"]);
    await recordHeartbeat(db, "job.a", "done", ago(9 * 86_400_000), undefined, "web-gone", gens["web-gone"]);
    await recordHeartbeat(db, "scheduler.tick", "done", ago(2 * 86_400_000), undefined, "web-old", gens["web-old"]);
    expect(await markInstanceRetired(db, ago(8 * 86_400_000), "web-gone", gens["web-gone"])).toBe(1);
    expect(await markInstanceRetired(db, ago(86_400_000), "web-old", gens["web-old"])).toBe(1);
    expect(await live()).toEqual(["web-new:scheduler.tick", "web-stuck:scheduler.tick"]);
    expect(await retired()).toEqual(["web-gone:job.a", "web-gone:scheduler.tick", "web-old:scheduler.tick"]);
    // 표시 뒤 7일 지난 web-gone만 지운다(종료 표시 없는 web-stuck은 오래돼도 남는다)
    expect(await purgeRetiredHeartbeats(db, now)).toBe(2);
    expect((await db.opsInstance.findMany()).map((i) => i.name).sort()).toEqual(["web-new", "web-old", "web-stuck"]);
    // 종료 뒤 늦게 도착한 heartbeat(종료 직전에 시작된 실행)는 표시를 되돌리지 않는다
    for (const st of ["done", "failed", "skipped"] as const) await recordHeartbeat(db, "scheduler.tick", st, now, "late", "web-old", gens["web-old"]);
    expect(await live()).toEqual(["web-new:scheduler.tick", "web-stuck:scheduler.tick"]);
    // 같은 이름으로 새로 시작해 등록하면 살아 있는 인스턴스로 돌아오고, 이전 세대 행은 빠진다
    const again = await registerInstance(db, "web-old");
    expect(await retired()).toEqual([]);
    await recordHeartbeat(db, "scheduler.tick", "done", now, undefined, "web-old", again);
    expect(await live()).toEqual(["web-new:scheduler.tick", "web-old:scheduler.tick", "web-stuck:scheduler.tick"]);
    expect((await import("../../lib/server/jobs/scheduler")).SCHEDULED_JOBS.map((j) => j.name)).toContain("ops_heartbeat.purge_retired");
  });

  it("같은 이름의 새 프로세스가 등록한 뒤 이전 프로세스가 종료돼도 새 프로세스는 살아 있는 쪽에 남는다(종료 표시는 자기 세대에만)", async () => {
    const now = new Date();
    const oldGen = await registerInstance(db, "web-x");
    await recordHeartbeat(db, "scheduler.tick", "done", now, undefined, "web-x", oldGen);
    const newGen = await registerInstance(db, "web-x");
    expect(newGen).not.toBe(oldGen);
    await recordHeartbeat(db, "scheduler.tick", "done", now, undefined, "web-x", newGen);
    expect(await markInstanceRetired(db, now, "web-x", oldGen)).toBe(0);
    expect(await live()).toEqual(["web-x:scheduler.tick"]);
    expect(await markInstanceRetired(db, now, "web-x", newGen)).toBe(1);
    expect(await retired()).toEqual(["web-x:scheduler.tick"]);
  });

  it("새 세대가 등록한 뒤 이전 세대의 늦은 heartbeat는 쓰지 않고 새 세대의 상태·시각·오류는 그대로다", async () => {
    const oldGen = await registerInstance(db, "web-y");
    await recordHeartbeat(db, "scheduler.tick", "done", t(0), undefined, "web-y", oldGen);
    const newGen = await registerInstance(db, "web-y");
    await recordHeartbeat(db, "scheduler.tick", "done", t(1), undefined, "web-y", newGen);
    expect(await recordHeartbeat(db, "scheduler.tick", "failed", t(2), "old boom", "web-y", oldGen)).toBe(0);
    expect(await recordHeartbeat(db, "scheduler.tick", "skipped", t(3), undefined, "web-y", oldGen)).toBe(0);
    expect(await recordHeartbeat(db, "old.job", "done", t(3), undefined, "web-y", oldGen)).toBe(0);
    const [h] = (await opsMetrics(db)).heartbeats;
    expect(h).toMatchObject({ instance: "web-y", job: "scheduler.tick", lastStatus: "done", lastError: null, lastRunAt: t(1), lastOkAt: t(1) });
    expect(await live()).toEqual(["web-y:scheduler.tick"]);
    await recordHeartbeat(db, "scheduler.tick", "failed", t(4), "new boom", "web-y", newGen);
    await recordHeartbeat(db, "scheduler.tick", "skipped", t(5), undefined, "web-y", newGen);
    expect((await opsMetrics(db)).heartbeats[0]).toMatchObject({ lastStatus: "failed", lastError: "new boom", lastRunAt: t(5), lastOkAt: t(1) });
  });

  it("배포로 사라진 작업의 행은 새 세대 등록 뒤 heartbeats에서 빠지고 정리가 지운다", async () => {
    const a = await registerInstance(db, "web-z");
    await recordHeartbeat(db, "kept.job", "done", t(0), undefined, "web-z", a);
    await recordHeartbeat(db, "removed.job", "done", t(0), undefined, "web-z", a);
    const b = await registerInstance(db, "web-z");
    await recordHeartbeat(db, "kept.job", "done", t(1), undefined, "web-z", b);
    expect(await live()).toEqual(["web-z:kept.job"]);
    expect(await purgeRetiredHeartbeats(db, new Date())).toBe(2);
    expect((await db.opsHeartbeat.findMany()).map((r) => [r.generation, r.job])).toEqual([[b, "kept.job"]]);
  });

  it("등록과 이전 세대 heartbeat가 겹쳐도 새 세대의 heartbeat는 막히지 않고, 지표에는 지금 세대만 보인다", async () => {
    const oldGen = await registerInstance(db, "web-r");
    // 이전 세대가 새 작업 행을 넣는 것과 새 프로세스 등록을 동시에
    const results = await Promise.all([
      ...Array.from({ length: 10 }, (_, i) => recordHeartbeat(db, `old.job.${i}`, "done", t(0), undefined, "web-r", oldGen)),
      registerInstance(db, "web-r", "gen-new"),
      ...Array.from({ length: 10 }, (_, i) => recordHeartbeat(db, `old.job.late.${i}`, "done", t(0), undefined, "web-r", oldGen)),
    ]);
    expect(results).toContain("gen-new");
    // 경합 결과로 이전 세대 행이 남아 있어도(직접 넣어 둔다) 새 세대는 쓰고, 지표는 새 세대만 본다
    await db.opsHeartbeat.create({ data: { instance: "web-r", generation: oldGen, job: "orphan.job", lastRunAt: t(0), lastStatus: "done" } });
    expect(await recordHeartbeat(db, "scheduler.tick", "done", t(1), undefined, "web-r", "gen-new")).toBe(1);
    expect(await live()).toEqual(["web-r:scheduler.tick"]);
  });

  it("시작 때 DB가 잠깐 실패해도 등록을 다시 시도해 성공하고, 그 뒤 실행의 heartbeat가 살아 있는 쪽에 들어간다", async () => {
    vi.stubEnv("OPS_INSTANCE_NAME", "web-retry");
    let fails = 2;
    const flaky = new Proxy(db, {
      get(target, p) {
        const v = Reflect.get(target, p);
        if (p === "$executeRaw" && fails > 0) {
          return async () => {
            fails--;
            throw new Error("연결 실패(테스트)");
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof db;
    const gen = await registerUntilDone(flaky, 10);
    expect(fails).toBe(0);
    expect(gen).toEqual(expect.any(String));
    await runScheduledJobs(db, new Date(), [{ name: "job", run: async () => 0 }]);
    expect((await live()).filter((x) => x.startsWith("web-retry:"))).toEqual(["web-retry:job", "web-retry:scheduler.tick"]);
    expect((await db.opsHeartbeat.findMany({ where: { instance: "web-retry" } })).every((r) => r.generation === gen)).toBe(true);
  });

  it("등록 중에 종료 신호를 받으면 등록이 끝난 뒤 스케줄러를 시작하지 않고 새 세대로 바로 종료 표시를 남긴다", async () => {
    vi.stubEnv("OPS_INSTANCE_NAME", "web-boot");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    let first = true;
    const slow = new Proxy(db, {
      get(target, p) {
        const v = Reflect.get(target, p);
        if (p === "$executeRaw" && first) {
          first = false;
          return async (...args: unknown[]) => {
            entered();
            await gate;
            return (v as (...a: unknown[]) => Promise<number>).apply(target, args);
          };
        }
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as typeof db;
    try {
      const registering = registerUntilDone(slow, 10);
      await started;
      const retiring = retireInstance(db, 2000);
      setTimeout(release, 100);
      const [gen] = await Promise.all([registering, retiring]);
      expect(gen).toBeNull();
      const inst = await db.opsInstance.findUniqueOrThrow({ where: { name: "web-boot" } });
      expect(inst.retiredAt).not.toBeNull();
      expect(await runScheduledJobs(db, new Date(), [{ name: "job", run: async () => 1 }])).toEqual([]);
    } finally {
      resetShutdownForTests();
    }
  });

  it("종료 처리 중에 진행 중이던 실행이 끝나도 종료 표시가 되돌아가지 않고, 종료 뒤에는 새 실행·heartbeat를 쓰지 않는다", async () => {
    vi.stubEnv("OPS_INSTANCE_NAME", "web-1");
    await registerInstance(db);
    try {
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
      expect((await db.opsInstance.findUniqueOrThrow({ where: { name: "web-1" } })).retiredAt).not.toBeNull();
      expect(await live()).toEqual([]);
      expect(await runScheduledJobs(db, new Date(), [{ name: "slow", run: async () => 1 }])).toEqual([]);
    } finally {
      resetShutdownForTests();
    }
  });

  it("같은 occurredAt의 열기·닫기는 늦게 들어온 쪽으로 정한다(한 번에 보내도, 따로 보내도)", async () => {
    vi.stubEnv("OPS_INGEST_TOKEN", TOKEN);
    const at = ago(10);
    await ingest({ events: [ev({ eventId: "a1", key: "health", kind: "incident_open", occurredAt: at }), ev({ eventId: "a2", key: "health", kind: "incident_close", occurredAt: at })] }, TOKEN);
    await ingest({ events: [ev({ eventId: "b1", key: "cert", kind: "incident_close", occurredAt: at })] }, TOKEN);
    await ingest({ events: [ev({ eventId: "b2", key: "cert", kind: "incident_open", occurredAt: at })] }, TOKEN);
    for (let i = 0; i < 5; i++) expect((await opsMetrics(db)).incidents.open.map((e) => e.key)).toEqual(["cert"]);
  });
});

describe("운영 지표 보완(Codex)", () => {
  it("열림·닫힘은 서버가 받은 순서로 정한다: 조금 미래 시각(5분 안)의 열림 뒤에 정상 시각의 닫힘이 오면 닫힌다. 1시간 뒤 시각은 전체 거부", async () => {
    vi.stubEnv("OPS_INGEST_TOKEN", TOKEN);
    const soon = new Date(Date.now() + 3 * 60_000).toISOString();
    expect((await ingest({ events: [ev({ eventId: "f1", key: "disk", kind: "incident_open", occurredAt: soon })] }, TOKEN)).status).toBe(200);
    expect((await opsMetrics(db)).incidents.open.map((e) => e.key)).toEqual(["disk"]);
    expect((await ingest({ events: [ev({ eventId: "f2", key: "disk", kind: "incident_close", occurredAt: ago(0) })] }, TOKEN)).status).toBe(200);
    expect((await opsMetrics(db)).incidents.open).toEqual([]);
    const later = new Date(Date.now() + 3600_000).toISOString();
    const bad = await ingest({ events: [ev({ eventId: "f3", key: "disk", kind: "incident_open", occurredAt: ago(1) }), ev({ eventId: "f4", key: "cpu", occurredAt: later })] }, TOKEN);
    expect(bad.status).toBe(400);
    expect(await db.opsEvent.count({ where: { eventId: { in: ["f3", "f4"] } } })).toBe(0);
  });

  it("열림·닫힘은 수집기(source)·key별: 두 수집기가 같은 key를 써도 A의 닫힘이 B의 열림을 닫지 않는다. 열린 사건에는 source가 있다", async () => {
    vi.stubEnv("OPS_INGEST_TOKEN", TOKEN);
    await ingest({ events: [ev({ source: "monitor-b", eventId: "g1", key: "health", kind: "incident_open", occurredAt: ago(5) })] }, TOKEN);
    await ingest({ events: [ev({ source: "monitor-a", eventId: "g2", key: "health", kind: "incident_open", occurredAt: ago(4) })] }, TOKEN);
    await ingest({ events: [ev({ source: "monitor-a", eventId: "g3", key: "health", kind: "incident_close", occurredAt: ago(3) })] }, TOKEN);
    expect((await opsMetrics(db)).incidents.open.map((e) => [e.source, e.key])).toEqual([["monitor-b", "health"]]);
  });

  it("받은 지 30일 지난 사건은 정리하되 (source, key)별 마지막 열림·닫힘은 남아 열린 상태가 유지된다. 1000건씩 나눠 지운다", async () => {
    const days = (d: number) => new Date(Date.now() - d * 86_400_000);
    const row = (source: string, eventId: string, kind: string, key: string, receivedDaysAgo: number) => ({
      source, eventId, kind, key, severity: "critical", message: "m", occurredAt: days(receivedDaysAgo), createdAt: days(receivedDaysAgo),
    });
    // A/health: 40일 전 열림 하나뿐 → 남아서 계속 열림
    await db.opsEvent.create({ data: row("monitor-a", "a1", "incident_open", "health", 40) });
    // B/cert: 40일 전 열림 → 35일 전 닫힘(마지막) → 열림만 지워지고 닫힘은 남음
    await db.opsEvent.create({ data: row("monitor-b", "b1", "incident_open", "cert", 40) });
    await db.opsEvent.create({ data: row("monitor-b", "b2", "incident_close", "cert", 35) });
    // 오래된 정보 사건 2500건(묶음 여러 번), 최근 정보 사건 1건
    await db.opsEvent.createMany({ data: Array.from({ length: 2500 }, (_, i) => row("monitor-a", `old-${i}`, "info", "note", 31)) });
    await db.opsEvent.create({ data: row("monitor-a", "recent", "info", "note", 1) });
    expect(await purgeOldOpsEvents(db, new Date())).toBe(2501);
    expect((await db.opsEvent.findMany({ orderBy: { eventId: "asc" } })).map((e) => e.eventId)).toEqual(["a1", "b2", "recent"]);
    expect((await opsMetrics(db)).incidents.open.map((e) => [e.source, e.key])).toEqual([["monitor-a", "health"]]);
    expect((await import("../../lib/server/jobs/scheduler")).SCHEDULED_JOBS.map((j) => j.name)).toContain("ops_event.purge_old");
  });

  it("등록만 하고 heartbeat가 없는 인스턴스도 heartbeats에 「시작 후 신호 없음」과 등록 시각으로 나온다", async () => {
    await registerInstance(db, "web-quiet");
    const gen = await registerInstance(db, "web-busy");
    await recordHeartbeat(db, "scheduler.tick", "done", new Date(), undefined, "web-busy", gen);
    const m = await opsMetrics(db);
    const quiet = m.heartbeats.find((h) => h.instance === "web-quiet");
    expect(quiet).toMatchObject({ job: null, lastRunAt: null, lastStatus: "no_signal", retiredAt: null });
    expect(quiet?.registeredAt).toBeInstanceOf(Date);
    expect(m.heartbeats.find((h) => h.instance === "web-busy")).toMatchObject({ job: "scheduler.tick", lastStatus: "done" });
  });
});

describe("운영 지표 GET /api/admin/ops/metrics", () => {
  it("최고관리자만 본다(운영·CS·조회 전용 403, 로그인 없음 401). DB 지연·연결 수·heartbeat·큐(not_measured)·열린 사건을 준다. 공개 health에는 없다", async () => {
    expect((await metrics()).status).toBe(401);
    for (const role of ["OPERATIONS", "CS", "READ_ONLY"] as const) expect((await metrics(await adminCookie(role))).status, role).toBe(403);
    vi.stubEnv("OPS_INGEST_TOKEN", TOKEN);
    await ingest({ events: [ev(), ev({ eventId: "e2", key: "cert", kind: "incident_open", occurredAt: ago(59) }), ev({ eventId: "e3", kind: "incident_close", occurredAt: ago(55), message: "복구" })] }, TOKEN);
    await registerInstance(db);
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
