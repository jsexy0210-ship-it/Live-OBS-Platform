import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { Prisma, type PrismaClient } from "@prisma/client";
import { hashToken } from "../auth/token";

// 앱 감시 훅(ONQ 단계 6 서버 몫, PR #159). 감시 자체는 앱과 같이 죽지 않도록 앱 밖 수집기(scripts/ops/monitor.mjs)가 한다.
// 앱은 ① 정기 실행 heartbeat를 DB에 남기고 ② 최고관리자에게 운영 지표를 보여 주고 ③ 수집기가 보낸 사건을 저장해 보여 준다.

type Db = PrismaClient | Prisma.TransactionClient;

// 인스턴스 이름: OPS_INSTANCE_NAME이 있으면 그 값, 없으면 호스트 이름(컨테이너 id)
export const opsInstanceName = () => (process.env.OPS_INSTANCE_NAME || hostname()).slice(0, 100);

// 정기 실행 heartbeat 남기기. 실패해도 정기 실행을 멈추지 않는다(호출한 쪽이 잡는다).
// - done: 마지막 실행·성공 시각을 갱신하고 오류를 비운다.
// - failed: 마지막 실행·상태·오류를 남기고 성공 시각은 그대로.
// - skipped(다른 인스턴스가 잠금을 잡음): 실행 결과를 모르므로 마지막 실행 시각만 남긴다(상태·성공 시각·오류는 그대로).
export async function recordHeartbeat(db: Db, job: string, status: "done" | "skipped" | "failed", now: Date, error?: string, instance = opsInstanceName()) {
  const err = status === "failed" ? (error?.slice(0, 500) ?? null) : null;
  await db.opsHeartbeat.upsert({
    where: { instance_job: { instance, job } },
    create: { instance, job, lastRunAt: now, lastStatus: status, lastError: err, lastOkAt: status === "done" ? now : null },
    update:
      status === "skipped"
        ? { lastRunAt: now }
        : { lastRunAt: now, lastStatus: status, lastError: err, ...(status === "done" ? { lastOkAt: now } : {}) },
  });
}

// 이 시간보다 오래 실행하지 않은 인스턴스는 종료된 것으로 본다(정기 실행 간격의 3배, 최소 24시간). 지표에서 따로 보여 주고
// 멈춤 경보 대상에서 뺀다. 배포마다 컨테이너 이름(인스턴스)이 바뀌어 옛 행이 남기 때문이다.
export const HEARTBEAT_RETIRED_AFTER_MS = Math.max(3 * 3600_000, 24 * 3600_000);
// 이보다 오래된 heartbeat 행은 정기 실행이 지운다(jobs/scheduler.ts)
export const HEARTBEAT_PURGE_AFTER_MS = 7 * 24 * 3600_000;

export async function purgeRetiredHeartbeats(db: Db, now: Date): Promise<number> {
  const r = await db.opsHeartbeat.deleteMany({ where: { lastRunAt: { lt: new Date(now.getTime() - HEARTBEAT_PURGE_AFTER_MS) } } });
  return r.count;
}

// 최고관리자용 운영 지표. 공개 /api/health에는 넣지 않는다.
// - db: SELECT 1 지연, 이 데이터베이스의 연결 수(활성·유휴·트랜잭션 중 유휴·잠금 대기)와 max_connections(연결 풀 사용량을 DB 쪽에서 본 값)
// - heartbeats: 인스턴스·작업별 마지막 실행
// - queueBacklog: 작업 큐가 아직 없어 not_measured(자동연결 큐가 생기면 여기에 넣는다)
// - incidents: 열린 사건(같은 key의 마지막이 incident_open)과 최근 사건 50개
export async function opsMetrics(db: PrismaClient, now = new Date()) {
  const t0 = performance.now();
  await db.$queryRaw`SELECT 1`;
  const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
  const [conn] = await db.$queryRaw<{ total: bigint; active: bigint; idle: bigint; idleInTx: bigint; waitingLock: bigint; max: number }[]>`
    SELECT count(*)::bigint AS total,
           count(*) FILTER (WHERE state = 'active')::bigint AS active,
           count(*) FILTER (WHERE state = 'idle')::bigint AS idle,
           count(*) FILTER (WHERE state LIKE 'idle in transaction%')::bigint AS "idleInTx",
           count(*) FILTER (WHERE wait_event_type = 'Lock')::bigint AS "waitingLock",
           current_setting('max_connections')::int AS max
    FROM pg_stat_activity WHERE datname = current_database()`;
  const heartbeats = await db.opsHeartbeat.findMany({ orderBy: [{ instance: "asc" }, { job: "asc" }] });
  const recent = await db.opsEvent.findMany({ orderBy: [{ occurredAt: "desc" }, { seq: "desc" }], take: 50 });
  // 같은 key의 마지막 열기·닫기. 같은 occurredAt이면 늦게 들어온 사건(seq)이 이긴다.
  const latestByKey = await db.$queryRaw<{ key: string; kind: string; occurredAt: Date; message: string; severity: string }[]>`
    SELECT DISTINCT ON ("key") "key", "kind", "occurredAt", "message", "severity"
    FROM "OpsEvent" WHERE "kind" IN ('incident_open', 'incident_close')
    ORDER BY "key", "occurredAt" DESC, "seq" DESC`;
  const retiredBefore = now.getTime() - HEARTBEAT_RETIRED_AFTER_MS;
  const beat = (h: (typeof heartbeats)[number]) => ({ instance: h.instance, job: h.job, lastRunAt: h.lastRunAt, lastStatus: h.lastStatus, lastOkAt: h.lastOkAt, lastError: h.lastError });
  return {
    checkedAt: new Date().toISOString(),
    db: {
      latencyMs,
      connections: {
        total: Number(conn.total),
        active: Number(conn.active),
        idle: Number(conn.idle),
        idleInTransaction: Number(conn.idleInTx),
        waitingLock: Number(conn.waitingLock),
        max: conn.max,
      },
    },
    // 살아 있는 인스턴스(멈춤 판단 대상)와 종료된 것으로 보는 인스턴스(HEARTBEAT_RETIRED_AFTER_MS 넘게 실행 없음, 7일 뒤 지움)
    heartbeats: heartbeats.filter((h) => h.lastRunAt.getTime() >= retiredBefore).map(beat),
    retiredHeartbeats: heartbeats.filter((h) => h.lastRunAt.getTime() < retiredBefore).map(beat),
    queueBacklog: "not_measured" as const,
    incidents: {
      open: latestByKey.filter((e) => e.kind === "incident_open"),
      recent: recent.map(({ seq, ...e }) => ({ ...e, seq: seq.toString() })),
    },
  };
}

// 수집기 쓰기 인증: Authorization: Bearer <OPS_INGEST_TOKEN>. 값이 없거나 32자 미만이면 쓰기 경로를 끈다(503).
export type IngestAuth = "ok" | "disabled" | "unauthorized";
export function checkIngestToken(header: string | null, env: NodeJS.ProcessEnv = process.env): IngestAuth {
  const secret = env.OPS_INGEST_TOKEN ?? "";
  if (secret.length < 32) return "disabled";
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return "unauthorized";
  // 길이가 달라도 시간 차가 나지 않게 해시끼리 비교
  return timingSafeEqual(Buffer.from(hashToken(m[1])), Buffer.from(hashToken(secret))) ? "ok" : "unauthorized";
}

const KINDS = new Set(["incident_open", "incident_close", "info", "warning"]);
const SEVERITIES = new Set(["info", "warning", "critical"]);
const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);

export type OpsEventInput = {
  source: string;
  eventId: string;
  kind: string;
  key: string;
  severity: string;
  message: string;
  detail: Prisma.InputJsonValue | null;
  occurredAt: Date;
};

// 본문 { events: [...] } 검사. 한 번에 1~50건, 하나라도 틀리면 전체 거부.
export function parseOpsEvents(raw: unknown): OpsEventInput[] | null {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { events?: unknown }).events) ? (raw as { events: unknown[] }).events : null;
  if (!list || list.length === 0 || list.length > 50) return null;
  const out: OpsEventInput[] = [];
  for (const e of list) {
    const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const source = str(o.source, 100);
    const eventId = str(o.eventId, 200);
    const kind = str(o.kind, 40);
    const key = str(o.key, 100);
    const severity = o.severity === undefined ? "info" : str(o.severity, 20);
    const message = str(o.message, 1000);
    const occurredAt = typeof o.occurredAt === "string" ? new Date(o.occurredAt) : null;
    if (!source || !eventId || !kind || !KINDS.has(kind) || !key || !severity || !SEVERITIES.has(severity) || !message || !occurredAt || Number.isNaN(occurredAt.getTime())) return null;
    const detail = o.detail === undefined || o.detail === null ? null : (o.detail as Prisma.InputJsonValue);
    if (detail !== null && JSON.stringify(detail).length > 8000) return null;
    out.push({ source, eventId, kind, key, severity, message, detail, occurredAt });
  }
  return out;
}

// 저장(같은 source·eventId는 건너뜀). 새로 저장한 수를 돌려준다.
export async function ingestOpsEvents(db: PrismaClient, events: OpsEventInput[]): Promise<number> {
  const r = await db.opsEvent.createMany({ data: events.map((e) => ({ ...e, detail: e.detail ?? Prisma.DbNull })), skipDuplicates: true });
  return r.count;
}
