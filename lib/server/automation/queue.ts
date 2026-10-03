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

// 고객 대기를 뺀 실행 시간 합계가 상한(6시간)을 넘었다. 작업자는 이것을 받으면 실패·전액 환불 처리 대기로 끝낸다.
export class RunTimeExceeded extends Error {
  constructor() {
    super("run_time_limit");
  }
}

export type Claim = { readonly jobId: string; readonly token: number };

// 지금 실행 자리에서 쓴 시간(ms)
const runningMs = (cur: { runStartedAt: Date | null }, now: Date) => (cur.runStartedAt ? Math.max(0, now.getTime() - cur.runStartedAt.getTime()) : 0);
export type Claimed = { job: AutomationJob; claim: Claim };

export async function dbNow(db: Tx | PrismaClient): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return rows[0].now;
}

// 작업 행 잠금(트랜잭션 안에서). 상태를 읽고 바꾸는 사이에 다른 쓰기가 끼지 않게 한다.
export async function lockJob(tx: Tx, jobId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "AutomationJob" WHERE id = ${jobId}::uuid FOR UPDATE`;
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
        runStartedAt: now,
      },
    });
    await writeJobEvent(tx, job, "QUEUED", "RUNNING", job.fencingToken, { workerId });
    return { job, claim: { jobId: job.id, token: job.fencingToken } };
  });
}

type FencedChange = {
  to?: AutomationJobStatus;
  data: Prisma.AutomationJobUpdateManyMutationInput;
  detail?: Record<string, unknown>;
  // 같은 트랜잭션에서 이어서 할 쓰기(예: 결제를 환불 처리 대기로)
  after?: (tx: Tx, cur: AutomationJob, now: Date) => Promise<void>;
};

// 작업자의 모든 쓰기는 여기를 거친다. 토큰이 같고, 실행 중 상태이고, lease가 아직 살아 있을 때만 쓴다.
async function fencedWrite(db: PrismaClient, c: Claim, build: (now: Date, cur: AutomationJob) => FencedChange): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockJob(tx, c.jobId);
    const now = await dbNow(tx);
    const cur = await tx.automationJob.findUnique({ where: { id: c.jobId } });
    if (!cur) throw new FencingError();
    const change = build(now, cur);
    const from = change.to ? sourcesOf(change.to).filter((s) => LEASED.includes(s)) : [...LEASED];
    // 실행 자리를 놓는 전이(대기·재시도·끝)면 이번에 쓴 실행 시간을 합계에 더한다
    const releasing = change.to && !LEASED.includes(change.to);
    const r = await tx.automationJob.updateMany({
      where: { id: c.jobId, fencingToken: c.token, status: { in: from }, leaseExpiresAt: { gt: now } },
      data: {
        ...change.data,
        ...(change.to ? { status: change.to } : {}),
        ...(releasing ? { activeMsUsed: cur.activeMsUsed + runningMs(cur, now), runStartedAt: null } : {}),
      },
    });
    if (r.count !== 1) throw new FencingError();
    if (change.to && change.to !== cur.status) await writeJobEvent(tx, cur, cur.status, change.to, c.token, change.detail);
    await change.after?.(tx, cur, now);
  });
}

const RELEASE = { leaseOwner: null, leaseExpiresAt: null } as const;

// lease 연장 + 쓴 비용·실행 통계(판단 호출 수·작업서 행동 수·화면 이탈 단계) 기록
export type TouchStats = { costUsed: number; plannerCalls?: number; playbookActions?: number; deviatedSteps?: string[]; deviatedNow?: boolean };
// 실행 시간 합계(대기 제외)가 상한을 넘었으면 던진다(touch·heartbeat 때 확인)
function assertRunTime(cur: AutomationJob, now: Date) {
  if (cur.activeMsUsed + runningMs(cur, now) > AUTOMATION_LIMITS.maxRunMs) throw new RunTimeExceeded();
}

export const touch = (db: PrismaClient, c: Claim, stats: TouchStats, leaseMs: number = AUTOMATION_LIMITS.leaseMs) =>
  fencedWrite(db, c, (now, cur) => (assertRunTime(cur, now), {
    data: {
      costUsed: stats.costUsed,
      ...(stats.plannerCalls !== undefined ? { plannerCalls: stats.plannerCalls } : {}),
      ...(stats.playbookActions !== undefined ? { playbookActions: stats.playbookActions } : {}),
      ...(stats.deviatedSteps !== undefined ? { deviatedSteps: stats.deviatedSteps } : {}),
      ...(stats.deviatedNow ? { lastDeviationAt: now } : {}),
      leaseExpiresAt: plus(now, leaseMs),
    },
  }));

// 다음 단계로. 이 단계에서 알게 된 연결 결과(쇼핑몰·OBS pairing)를 함께 남긴다.
// lease만 연장(작업자 heartbeat). 외부 호출이 오래 걸려도 다른 작업자가 가져가지 않게 따로 주기적으로 부른다.
export const extendLease = (db: PrismaClient, c: Claim, leaseMs: number = AUTOMATION_LIMITS.leaseMs) =>
  fencedWrite(db, c, (now, cur) => (assertRunTime(cur, now), { data: { leaseExpiresAt: plus(now, leaseMs) } }));

// 결제를 환불 처리 대기로(확정 ②: 성공 기준 미통과 실패). 결제가 없거나(무료 재연결) PAID가 아니면 아무것도 안 한다.
export async function markRefundPending(tx: Tx, job: { id: string; sellerId: string; paymentId: string | null }, reason: string, now: Date) {
  if (!job.paymentId) return;
  const r = await tx.automationPayment.updateMany({
    where: { id: job.paymentId, status: "PAID" },
    data: { status: "REFUND_PENDING", refundReason: reason, refundRequestedAt: now },
  });
  if (r.count === 1) {
    await tx.auditLog.create({
      data: { actorType: "SYSTEM", sellerId: job.sellerId, action: "automation.refund_request", targetType: "AutomationPayment", targetId: job.paymentId, after: { jobId: job.id, reason } },
    });
  }
}

// 실패로 끝내고 결제를 전액 환불 처리 대기로(실행 시간 상한 초과 등)
export const failWithRefund = (db: PrismaClient, c: Claim, reason: string) =>
  fencedWrite(db, c, (now) => ({
    to: "FAILED",
    data: { ...RELEASE, finishedAt: now, lastError: reason },
    detail: { reason },
    after: (tx, cur, at) => markRefundPending(tx, cur, reason, at),
  }));

// 브라우저 상태 보관 직전 「보관 중」 표시(보관본을 놓치지 않게 보관보다 먼저 남긴다)
export const markBrowserStateHeld = (db: PrismaClient, c: Claim) => fencedWrite(db, c, () => ({ data: { browserStateHeld: true } }));

// 같은 PC 잠금을 실제 PC(OBS pairing)로 옮긴다. OBS를 처음 바꾸기 직전에 부른다.
// 그 PC에서 다른 작업이 실행 중이면 부분 유니크(AutomationJob_one_running_per_obs_target)가 막고(P2002) 작업자는 obs_target_busy로 나중에 다시 한다.
export const claimObsTarget = (db: PrismaClient, c: Claim, pairingId: string) =>
  fencedWrite(db, c, () => ({ data: { obsTargetKey: `obs:${pairingId.slice(0, 200)}` } }));

// 무료 재연결 대조 통과 기록(그때의 쇼핑몰·PC와 시각)
export const markTargetVerified = (db: PrismaClient, c: Claim, target: { shopKey: string; obsPairingId: string }) =>
  fencedWrite(db, c, (now) => ({ data: { targetVerifiedAt: now, shopKey: target.shopKey.slice(0, 200), obsPairingId: target.obsPairingId.slice(0, 200) } }));

export const advanceStep = (db: PrismaClient, c: Claim, stepIndex: number, facts: ConnectionFacts = {}) =>
  fencedWrite(db, c, () => ({
    data: {
      stepIndex,
      ...(facts.shopKey ? { shopKey: facts.shopKey.slice(0, 200) } : {}),
      ...(facts.obsPairingId ? { obsPairingId: facts.obsPairingId.slice(0, 200) } : {}),
    },
  }));

export const toVerifying = (db: PrismaClient, c: Claim) => fencedWrite(db, c, () => ({ to: "VERIFYING", data: {} }));

// 고객 행동이 필요하면 실행 자리를 반납하고 기다린다(다른 작업이 그 자리를 쓴다).
export const parkForCustomer = (db: PrismaClient, c: Claim, action: AutomationCustomerAction, heldBrowserState = false) =>
  fencedWrite(db, c, (now) => ({
    to: "NEEDS_CUSTOMER",
    data: {
      ...RELEASE,
      customerAction: action,
      actionDeadlineAt: plus(now, AUTOMATION_LIMITS.customerActionMs),
      ...(heldBrowserState ? { browserStateHeld: true } : {}),
    },
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
        data: {
          ...(give
            ? { ...RELEASE, status: "FAILED" as const, attempts, lastError: "lease_expired", finishedAt: now, fencingToken: { increment: 1 } }
            : { ...RELEASE, status: "QUEUED" as const, attempts, lastError: "lease_expired", runAfter: plus(now, backoffMs(attempts, random)), fencingToken: { increment: 1 } }),
          // 멈춘 작업자가 쓴 시간도 실행 시간에 넣는다(lease가 끝난 시각까지)
          activeMsUsed: cur.activeMsUsed + (cur.leaseExpiresAt ? runningMs(cur, cur.leaseExpiresAt) : 0),
          runStartedAt: null,
        },
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
      // 마감으로 끝난 작업은 성공 기준을 통과하지 못했으므로 확정 ②대로 전액 환불 처리 대기로 둔다(실제 환불 실행은 승인 뒤)
      await markRefundPending(tx, job, "customer_action_timeout", now);
      failed++;
    }
    return { requeued, failed };
  });
}
