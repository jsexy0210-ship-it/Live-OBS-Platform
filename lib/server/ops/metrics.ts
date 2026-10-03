import { randomUUID, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { Prisma, type PrismaClient } from "@prisma/client";
import { hashToken } from "../auth/token";

// 앱 감시 훅(ONQ 단계 6 서버 몫, PR #159). 감시 자체는 앱과 같이 죽지 않도록 앱 밖 수집기(scripts/ops/monitor.mjs)가 한다.
// 앱은 ① 정기 실행 heartbeat를 DB에 남기고 ② 최고관리자에게 운영 지표를 보여 주고 ③ 수집기가 보낸 사건을 저장해 보여 준다.

type Db = PrismaClient | Prisma.TransactionClient;

// 인스턴스 이름: OPS_INSTANCE_NAME이 있으면 그 값, 없으면 호스트 이름(컨테이너 id)
export const opsInstanceName = () => (process.env.OPS_INSTANCE_NAME || hostname()).slice(0, 100);

// 인스턴스 상태의 유일한 기준은 OpsInstance(이름별 현재 세대·종료 시각)다. heartbeat는 (인스턴스, 세대, 작업)별로 쌓이고,
// 지표는 인스턴스의 현재 세대와 같은 행만 「현재」로 본다. 그래서 이전 세대 프로세스의 늦은 기록, 배포로 사라진 작업의 행은
// 자동으로 빠지고 정기 정리가 지운다. 종료는 명시 신호(SIGTERM·SIGINT)로만 판단한다: 나이만으로 종료로 보면 heartbeat만 고장 난
// 살아 있는 인스턴스를 놓친다. 종료 표시가 없는 인스턴스의 행은 오래돼도 heartbeats에 남아 멈춤으로 보인다.

// 이 프로세스의 세대 값. registerInstance가 성공하면 정한다(개발 핫 리로드에도 하나만 두도록 globalThis).
const generationState = globalThis as unknown as { liveObsOpsGeneration?: string };
export const currentGeneration = (): string | null => generationState.liveObsOpsGeneration ?? null;

// 정기 실행 heartbeat 남기기. 실패해도 정기 실행을 멈추지 않는다(호출한 쪽이 잡는다). 쓴 행 수(0 또는 1)를 돌려준다.
// - done: 마지막 실행·성공 시각을 갱신하고 오류를 비운다.
// - failed: 마지막 실행·상태·오류를 남기고 성공 시각은 그대로.
// - skipped(다른 인스턴스가 잠금을 잡음): 실행 결과를 모르므로 마지막 실행 시각만 남긴다(상태·성공 시각·오류는 그대로).
// 같은 트랜잭션에서 OpsInstance 행을 FOR SHARE로 읽어 내 세대가 지금 세대일 때만 쓴다(등록의 FOR UPDATE와 줄을 세움).
// 등록하지 않았거나 다른 세대가 등록했으면 쓰지 않는다.
export async function recordHeartbeat(
  db: PrismaClient,
  job: string,
  status: "done" | "skipped" | "failed",
  now: Date,
  error?: string,
  instance = opsInstanceName(),
  generation = currentGeneration(),
): Promise<number> {
  if (!generation) return 0;
  const err = status === "failed" ? (error?.slice(0, 500) ?? null) : null;
  return db.$transaction(async (tx) => {
    const [cur] = await tx.$queryRaw<{ generation: string }[]>`SELECT "generation" FROM "OpsInstance" WHERE "name" = ${instance} FOR SHARE`;
    if (cur?.generation !== generation) return 0;
    await tx.opsHeartbeat.upsert({
      where: { instance_generation_job: { instance, generation, job } },
      create: { instance, generation, job, lastRunAt: now, lastStatus: status, lastError: err, lastOkAt: status === "done" ? now : null },
      update:
        status === "skipped"
          ? { lastRunAt: now }
          : { lastRunAt: now, lastStatus: status, lastError: err, ...(status === "done" ? { lastOkAt: now } : {}) },
    });
    return 1;
  });
}

// 인스턴스 등록: 프로세스가 새로 시작할 때 한 번(jobs/scheduler.ts, 성공할 때까지 다시 시도). OpsInstance 행을 잠그고(없으면 만든다)
// 새 세대 값을 쓰고 종료 표시를 비운다. heartbeat 행은 건드리지 않는다(이전 세대 행은 지표에서 빠지고 정리가 지운다).
export async function registerInstance(db: PrismaClient, instance = opsInstanceName(), generation: string = randomUUID()): Promise<string> {
  await db.$executeRaw`
    INSERT INTO "OpsInstance" ("name", "generation", "retiredAt", "registeredAt") VALUES (${instance}, ${generation}, NULL, now())
    ON CONFLICT ("name") DO UPDATE SET "generation" = EXCLUDED."generation", "retiredAt" = NULL, "registeredAt" = EXCLUDED."registeredAt"`;
  generationState.liveObsOpsGeneration = generation;
  return generation;
}

// 종료 표시: 인스턴스가 정상 종료할 때(jobs/scheduler.ts 종료 신호 처리) 자기 세대일 때만 OpsInstance에 남긴다.
// 같은 이름으로 먼저 등록한 후속 프로세스가 있으면 이전 프로세스의 종료는 아무것도 바꾸지 않는다.
export async function markInstanceRetired(db: Db, now: Date, instance = opsInstanceName(), generation = currentGeneration()): Promise<number> {
  if (!generation) return 0;
  return db.$executeRaw`UPDATE "OpsInstance" SET "retiredAt" = ${now} WHERE "name" = ${instance} AND "generation" = ${generation} AND "retiredAt" IS NULL`;
}

// 정리(정기 실행 ops_heartbeat.purge_retired): ① 인스턴스의 지금 세대가 아닌 heartbeat 행(이전 세대·배포로 사라진 작업 포함)과
// ② 종료 표시 뒤 7일이 지난 인스턴스와 그 행을 지운다. 지운 heartbeat 행 수를 돌려준다.
export const HEARTBEAT_PURGE_AFTER_MS = 7 * 24 * 3600_000;

export async function purgeRetiredHeartbeats(db: Db, now: Date): Promise<number> {
  const before = new Date(now.getTime() - HEARTBEAT_PURGE_AFTER_MS);
  const stale = await db.$executeRaw`
    DELETE FROM "OpsHeartbeat" h
    WHERE NOT EXISTS (SELECT 1 FROM "OpsInstance" i WHERE i."name" = h."instance" AND i."generation" = h."generation" AND (i."retiredAt" IS NULL OR i."retiredAt" >= ${before}))`;
  await db.$executeRaw`DELETE FROM "OpsInstance" WHERE "retiredAt" < ${before}`;
  return stale;
}

// 최고관리자용 운영 지표. 공개 /api/health에는 넣지 않는다.
// - db: SELECT 1 지연, 이 데이터베이스의 연결 수(활성·유휴·트랜잭션 중 유휴·잠금 대기)와 max_connections(연결 풀 사용량을 DB 쪽에서 본 값)
// - heartbeats: 인스턴스·작업별 마지막 실행
// - queueBacklog: 작업 큐가 아직 없어 not_measured(자동연결 큐가 생기면 여기에 넣는다)
// - incidents: 열린 사건(같은 key에서 마지막으로 받은 것이 incident_open)과 최근 받은 사건 50개
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
  // 인스턴스 기준으로 지금 세대 행만(이전 세대·사라진 작업 행은 빠짐). 종료 표시는 인스턴스 기준.
  // 등록했지만 아직 heartbeat가 없는 인스턴스도 job null·lastStatus "no_signal"(시작 후 신호 없음)로 내보내,
  // 감시가 registeredAt부터 지난 시간으로 판단할 수 있게 한다(첫 실행 전에 멈춘 인스턴스를 놓치지 않게).
  const heartbeats = await db.$queryRaw<
    {
      instance: string;
      job: string | null;
      lastRunAt: Date | null;
      lastStatus: string | null;
      lastOkAt: Date | null;
      lastError: string | null;
      retiredAt: Date | null;
      registeredAt: Date;
    }[]
  >`
    SELECT i."name" AS "instance", h."job", h."lastRunAt", h."lastStatus", h."lastOkAt", h."lastError", i."retiredAt", i."registeredAt"
    FROM "OpsInstance" i LEFT JOIN "OpsHeartbeat" h ON h."instance" = i."name" AND h."generation" = i."generation"
    ORDER BY i."name", h."job" NULLS FIRST`;
  const recent = await db.opsEvent.findMany({ orderBy: { seq: "desc" }, take: 50 });
  // 같은 key의 마지막 열기·닫기는 서버가 받은 순서(seq)로 정한다. occurredAt은 표시용이다(수집기 시계가 틀려도 상태가 꼬이지 않게).
  const latestByKey = await db.$queryRaw<{ key: string; kind: string; occurredAt: Date; message: string; severity: string }[]>`
    SELECT DISTINCT ON ("key") "key", "kind", "occurredAt", "message", "severity"
    FROM "OpsEvent" WHERE "kind" IN ('incident_open', 'incident_close')
    ORDER BY "key", "seq" DESC`;
  const beat = (h: (typeof heartbeats)[number]) => ({
    instance: h.instance,
    job: h.job,
    lastRunAt: h.lastRunAt,
    lastStatus: h.lastStatus ?? "no_signal",
    lastOkAt: h.lastOkAt,
    lastError: h.lastError,
    retiredAt: h.retiredAt,
    registeredAt: h.registeredAt,
  });
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
    // 살아 있는 인스턴스(종료 표시 없음, 오래돼도 멈춤 판단 대상)와 정상 종료한 인스턴스(종료 표시 있음, 7일 뒤 지움)
    heartbeats: heartbeats.filter((h) => !h.retiredAt).map(beat),
    retiredHeartbeats: heartbeats.filter((h) => h.retiredAt).map(beat),
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
// 받은 시각보다 이만큼 넘게 미래인 occurredAt은 거부한다(수집기 시계 오류)
export const OPS_EVENT_MAX_FUTURE_MS = 5 * 60_000;

export function parseOpsEvents(raw: unknown, now: Date = new Date()): OpsEventInput[] | null {
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
    if (occurredAt.getTime() > now.getTime() + OPS_EVENT_MAX_FUTURE_MS) return null;
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
