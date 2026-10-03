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
export async function recordHeartbeat(db: Db, job: string, status: "done" | "skipped" | "failed", now: Date, error?: string, instance = opsInstanceName()) {
  const ok = status !== "failed";
  await db.opsHeartbeat.upsert({
    where: { instance_job: { instance, job } },
    create: { instance, job, lastRunAt: now, lastStatus: status, lastError: ok ? null : (error?.slice(0, 500) ?? null), lastOkAt: ok ? now : null },
    update: { lastRunAt: now, lastStatus: status, lastError: ok ? null : (error?.slice(0, 500) ?? null), ...(ok ? { lastOkAt: now } : {}) },
  });
}

// 최고관리자용 운영 지표. 공개 /api/health에는 넣지 않는다.
// - db: SELECT 1 지연, 이 데이터베이스의 연결 수(활성·유휴·트랜잭션 중 유휴·잠금 대기)와 max_connections(연결 풀 사용량을 DB 쪽에서 본 값)
// - heartbeats: 인스턴스·작업별 마지막 실행
// - queueBacklog: 작업 큐가 아직 없어 not_measured(자동연결 큐가 생기면 여기에 넣는다)
// - incidents: 열린 사건(같은 key의 마지막이 incident_open)과 최근 사건 50개
export async function opsMetrics(db: PrismaClient) {
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
  const recent = await db.opsEvent.findMany({ orderBy: { occurredAt: "desc" }, take: 50 });
  const latestByKey = await db.$queryRaw<{ key: string; kind: string; occurredAt: Date; message: string; severity: string }[]>`
    SELECT DISTINCT ON ("key") "key", "kind", "occurredAt", "message", "severity"
    FROM "OpsEvent" WHERE "kind" IN ('incident_open', 'incident_close')
    ORDER BY "key", "occurredAt" DESC`;
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
    heartbeats: heartbeats.map((h) => ({ instance: h.instance, job: h.job, lastRunAt: h.lastRunAt, lastStatus: h.lastStatus, lastOkAt: h.lastOkAt, lastError: h.lastError })),
    queueBacklog: "not_measured" as const,
    incidents: {
      open: latestByKey.filter((e) => e.kind === "incident_open"),
      recent,
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
