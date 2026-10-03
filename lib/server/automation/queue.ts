import type { AutomationCustomerAction, AutomationJob, AutomationJobStatus, Prisma, PrismaClient } from "@prisma/client";
import { AUTOMATION_LIMITS } from "./config";
import type { ConnectionFacts, VerificationEvidence } from "./ports";
import { LEASED, sourcesOf } from "./states";
import { STEPS } from "./steps";

// 작업 큐: 실행 자리 잡기(lease) · fencing 토큰 · 만료 회수 · 다시 시도 간격.
// 주문 처리와 테이블·잠금을 나눈다(판매자 행을 잠그지 않는다). 그래서 자동 연결이 몰려도 주문 API를 막지 않는다.
type Tx = Prisma.TransactionClient;

// 실행 자리를 잃은 작업자(만료·취소·다른 작업자가 가져감)의 쓰기를 거부할 때 던진다.
export class FencingError extends Error {
  constructor() {
    super("fencing_rejected");
  }
}

export type Claim = { readonly jobId: string; readonly token: number };
export type Claimed = { job: AutomationJob; claim: Claim };

export async function dbNow(db: Tx | PrismaClient): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return rows[0].now;
}

const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

// 다시 시도 간격: 지수 증가(5초·10초·20초…, 상한 10분)에 50~100% 지터. 같은 순간 실패한 작업들이 같이 몰리지 않게 한다.
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(AUTOMATION_LIMITS.backoffCapMs, AUTOMATION_LIMITS.backoffBaseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.5 + random() * 0.5));
}

export async function writeJobEvent(
  tx: Tx,
  job: { id: string; sellerId: string },
  from: AutomationJobStatus | null,
  to: AutomationJobStatus,
  fencingToken: number,
  detail?: Record<string, unknown>,
) {
  await tx.automationJobEvent.create({
    data: { sellerId: job.sellerId, jobId: job.id, fromStatus: from, toStatus: to, fencingToken, detail: detail as Prisma.InputJsonValue | undefined },
  });
}

// 다음 작업 하나에 실행 자리를 잡는다. 조건: QUEUED, 실행 시각 지남, 같은 OBS 대상에 실행 중 작업 없음, 전체 실행 수 < 상한.
// 판매자당 열린 작업이 1개(부분 유니크)라 실행 시각 순(FIFO)으로 고르면 한 판매자가 자리를 독차지하지 못한다.
export async function claimNext(
  db: PrismaClient,
  workerId: string,
  opts: { leaseMs?: number; maxRunning?: number } = {},
): Promise<Claimed | null> {
  const leaseMs = opts.leaseMs ?? AUTOMATION_LIMITS.leaseMs;
  const maxRunning = opts.maxRunning ?? AUTOMATION_LIMITS.maxRunning;
  return db.$transaction(async (tx) => {
    // 실행 수 세기와 고르기를 한 번에 하나씩 해야 상한을 넘지 않는다(자동 연결 전용 잠금, 주문 처리와 무관).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('automation_claim'))`;
    const running = await tx.automationJob.count({ where: { status: { in: [...LEASED] } } });
    if (running >= maxRunning) return null;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT j.id FROM "AutomationJob" j
      WHERE j.status = 'QUEUED' AND j."runAfter" <= now()
        AND NOT EXISTS (
          SELECT 1 FROM "AutomationJob" r
          WHERE r."obsTargetKey" = j."obsTargetKey" AND r.status IN ('RUNNING', 'VERIFYING'))
      ORDER BY j."runAfter", j."createdAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return null;
    const now = await dbNow(tx);
    const before = await tx.automationJob.findUniqueOrThrow({ where: { id: rows[0].id } });
    const job = await tx.automationJob.update({
      where: { id: before.id },
      data: {
        status: "RUNNING",
        leaseOwner: workerId,
        leaseExpiresAt: plus(now, leaseMs),
        fencingToken: { increment: 1 },
        startedAt: before.startedAt ?? now,
      },
    });
    await writeJobEvent(tx, job, "QUEUED", "RUNNING", job.fencingToken, { workerId });
    return { job, claim: { jobId: job.id, token: job.fencingToken } };
  });
}

type FencedChange = { to?: AutomationJobStatus; data: Prisma.AutomationJobUpdateManyMutationInput; detail?: Record<string, unknown> };

// 작업자의 모든 쓰기는 여기를 거친다. 토큰이 같고, 실행 중 상태이고, lease가 아직 살아 있을 때만 쓴다.
async function fencedWrite(db: PrismaClient, c: Claim, build: (now: Date, cur: AutomationJob) => FencedChange): Promise<void> {
  await db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const cur = await tx.automationJob.findUnique({ where: { id: c.jobId } });
    if (!cur) throw new FencingError();
    const change = build(now, cur);
    const from = change.to ? sourcesOf(change.to).filter((s) => LEASED.includes(s)) : [...LEASED];
    const r = await tx.automationJob.updateMany({
      where: { id: c.jobId, fencingToken: c.token, status: { in: from }, leaseExpiresAt: { gt: now } },
      data: { ...change.data, ...(change.to ? { status: change.to } : {}) },
    });
    if (r.count !== 1) throw new FencingError();
    if (change.to && change.to !== cur.status) await writeJobEvent(tx, cur, cur.status, change.to, c.token, change.detail);
  });
}

const RELEASE = { leaseOwner: null, leaseExpiresAt: null } as const;

// lease 연장 + 쓴 비용·실행 통계(판단 호출 수·작업서 행동 수·화면 이탈 단계) 기록
export type TouchStats = { costUsed: number; plannerCalls?: number; playbookActions?: number; deviatedSteps?: string[] };
export const touch = (db: PrismaClient, c: Claim, stats: TouchStats, leaseMs: number = AUTOMATION_LIMITS.leaseMs) =>
  fencedWrite(db, c, (now) => ({
    data: {
      costUsed: stats.costUsed,
      ...(stats.plannerCalls !== undefined ? { plannerCalls: stats.plannerCalls } : {}),
      ...(stats.playbookActions !== undefined ? { playbookActions: stats.playbookActions } : {}),
      ...(stats.deviatedSteps !== undefined ? { deviatedSteps: stats.deviatedSteps } : {}),
      leaseExpiresAt: plus(now, leaseMs),
    },
  }));

// 다음 단계로. 이 단계에서 알게 된 연결 결과(쇼핑몰·OBS pairing)를 함께 남긴다.
// lease만 연장(작업자 heartbeat). 외부 호출이 오래 걸려도 다른 작업자가 가져가지 않게 따로 주기적으로 부른다.
export const extendLease = (db: PrismaClient, c: Claim, leaseMs: number = AUTOMATION_LIMITS.leaseMs) =>
  fencedWrite(db, c, (now) => ({ data: { leaseExpiresAt: plus(now, leaseMs) } }));

export const advanceStep = (db: PrismaClient, c: Claim, stepIndex: number, facts: ConnectionFacts = {}) =>
  fencedWrite(db, c, () => ({
    data: { stepIndex, ...(facts.shopKey ? { shopKey: facts.shopKey.slice(0, 200) } : {}), ...(facts.obsPairingId ? { obsPairingId: facts.obsPairingId.slice(0, 200) } : {}) },
  }));

export const toVerifying = (db: PrismaClient, c: Claim) => fencedWrite(db, c, () => ({ to: "VERIFYING", data: {} }));

// 고객 행동이 필요하면 실행 자리를 반납하고 기다린다(다른 작업이 그 자리를 쓴다).
export const parkForCustomer = (db: PrismaClient, c: Claim, action: AutomationCustomerAction) =>
  fencedWrite(db, c, (now) => ({
    to: "NEEDS_CUSTOMER",
    data: { ...RELEASE, customerAction: action, actionDeadlineAt: plus(now, AUTOMATION_LIMITS.customerActionMs) },
    detail: { customerAction: action },
  }));

// 일시 오류: 시도 횟수를 올리고 backoff 뒤 다시 대기열로. 횟수를 다 쓰면 실패로 닫는다.
export const retryLater = (db: PrismaClient, c: Claim, reason: string, random: () => number = Math.random) =>
  fencedWrite(db, c, (now, cur) => {
    const attempts = cur.attempts + 1;
    const lastError = reason.slice(0, 200);
    if (attempts >= cur.maxAttempts) return { to: "FAILED", data: { ...RELEASE, attempts, lastError, finishedAt: now }, detail: { reason: lastError } };
    return { to: "QUEUED", data: { ...RELEASE, attempts, lastError, runAfter: plus(now, backoffMs(attempts, random)) }, detail: { reason: lastError } };
  });

// 완료는 검증 증거와 함께만 남긴다(성공 기준: 테스트 주문이 고객 OBS 오버레이에 표시됨).
export const finishJob = (db: PrismaClient, c: Claim, to: "SUCCEEDED" | "FAILED", reason?: string, evidence?: VerificationEvidence) =>
  fencedWrite(db, c, (now) => ({
    to,
    data: {
      ...RELEASE,
      finishedAt: now,
      ...(reason ? { lastError: reason.slice(0, 200) } : {}),
      // 성공은 검증 증거와 마지막 진행 위치를 같은 쓰기로 남긴다
      ...(evidence ? { verifiedAt: now, verificationEvidence: evidence as Prisma.InputJsonValue, stepIndex: STEPS.length } : {}),
    },
    ...(reason ? { detail: { reason: reason.slice(0, 200) } } : {}),
  }));

// lease가 끝난 실행 중 작업을 회수한다(작업자 중단·멈춤). 토큰을 올려 이전 작업자의 늦은 쓰기를 막는다.
// 고객 행동 마감이 지난 작업은 실패로 닫는다.
export async function reapExpired(db: PrismaClient, random: () => number = Math.random): Promise<{ requeued: number; failed: number }> {
  return db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    let requeued = 0;
    let failed = 0;
    const expired = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AutomationJob"
      WHERE status IN ('RUNNING', 'VERIFYING') AND "leaseExpiresAt" <= now()
      LIMIT 100 FOR UPDATE SKIP LOCKED`;
    for (const { id } of expired) {
      const cur = await tx.automationJob.findUniqueOrThrow({ where: { id } });
      const attempts = cur.attempts + 1;
      const give = attempts >= cur.maxAttempts;
      const job = await tx.automationJob.update({
        where: { id },
        data: give
          ? { ...RELEASE, status: "FAILED", attempts, lastError: "lease_expired", finishedAt: now, fencingToken: { increment: 1 } }
          : { ...RELEASE, status: "QUEUED", attempts, lastError: "lease_expired", runAfter: plus(now, backoffMs(attempts, random)), fencingToken: { increment: 1 } },
      });
      await writeJobEvent(tx, job, cur.status, job.status, job.fencingToken, { reason: "lease_expired" });
      if (give) failed++;
      else requeued++;
    }
    const waiting = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AutomationJob"
      WHERE status = 'NEEDS_CUSTOMER' AND "actionDeadlineAt" <= now()
      LIMIT 100 FOR UPDATE SKIP LOCKED`;
    for (const { id } of waiting) {
      const job = await tx.automationJob.update({
        where: { id },
        data: { status: "FAILED", lastError: "customer_action_timeout", finishedAt: now, customerAction: null, actionDeadlineAt: null },
      });
      await writeJobEvent(tx, job, "NEEDS_CUSTOMER", "FAILED", job.fencingToken, { reason: "customer_action_timeout" });
      failed++;
    }
    return { requeued, failed };
  });
}
