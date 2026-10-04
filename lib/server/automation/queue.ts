import { Prisma, type AutomationCustomerAction, type AutomationJob, type AutomationJobStatus, type PrismaClient } from "@prisma/client";
import { AUTOMATION_LIMITS } from "./config";
import type { ChangeMark } from "./engine";
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
// 전체 마감(72시간)이 지나도 같은 방식으로 던진다(사유 total_deadline).
export class RunTimeExceeded extends Error {
  constructor(reason: "run_time_limit" | "total_deadline" = "run_time_limit") {
    super(reason);
  }
}

// 시간 한도(docs/AUTOMATION.md 「시간 한도」 표와 1:1). 마감 판단은 모두 이 함수만 쓴다(claim·회수·고객 대기·재개·실행 중 확인).
// start: 대기열에 들어간 뒤 실행을 시작하지 못한 작업의 시작 마감, total: 실행을 시작한 작업의 전체 마감,
// customerActionAt: 고객 대기 마감(지금 + 24시간, 전체 마감보다 늦지 않게)
export function deadlinesFor(job: Pick<AutomationJob, "queuedAt" | "startedAt">) {
  const start = !job.startedAt && job.queuedAt ? plus(job.queuedAt, AUTOMATION_LIMITS.startDeadlineMs) : null;
  const total = job.startedAt ? plus(job.startedAt, AUTOMATION_LIMITS.totalDeadlineMs) : null;
  const customerActionAt = (now: Date) => {
    const wait = plus(now, AUTOMATION_LIMITS.customerActionMs);
    return total && total < wait ? total : wait;
  };
  return { start, total, customerActionAt };
}

// 외부 행동 격리 창(공용 장치): 이미 시작된 외부 행동은 토큰으로 취소할 수 없으므로, 소유권이 넘어가거나 닫히는 모든 지점
// (작업 인수·같은 OBS 대상의 다른 작업·보관 자료 삭제·정리 닫기·새 연습)은 옛 소유자의 종료 확인(ack) 또는
// 마지막 행동 시작 + 행동 상한 + 여유 경과 중 먼저 오는 것까지 기다린다. 아래 SQL 조각은 같은 규칙의 후보 고르기용이다.
export type ActionWindow = { lastActionStartedAt: Date | null; lastActionEndedAt: Date | null };
export const QUIESCE_MS = AUTOMATION_LIMITS.actionTimeoutMs + AUTOMATION_LIMITS.actionQuiesceGraceMs;
export function quiescent(row: ActionWindow, now: Date): boolean {
  const started = row.lastActionStartedAt;
  if (!started) return true;
  if (row.lastActionEndedAt && row.lastActionEndedAt >= started) return true;
  return now.getTime() >= started.getTime() + QUIESCE_MS;
}
export const quiescentSql = (alias: string) =>
  Prisma.raw(
    `(${alias}."lastActionStartedAt" IS NULL OR ${alias}."lastActionEndedAt" >= ${alias}."lastActionStartedAt" OR ${alias}."lastActionStartedAt" <= clock_timestamp() - interval '${QUIESCE_MS} milliseconds')`,
  );

// 외부 행동 시작 기록(점유 확인 포함: 자리를 잃었으면 던져 행동하지 않는다)과 종료 확인(자리를 잃었어도 남긴다: 끝났다는 사실이므로)
export const markActionStarted = (db: PrismaClient, c: Claim) => fencedWrite(db, c, (now) => ({ data: { lastActionStartedAt: now } }));
export const markActionEnded = (db: PrismaClient, jobId: string) => db.$executeRaw`UPDATE "AutomationJob" SET "lastActionEndedAt" = clock_timestamp() WHERE id = ${jobId}::uuid`;

// 지금 넘긴 마감(시작·전체)이 있으면 그 사유
export function overdue(job: Pick<AutomationJob, "queuedAt" | "startedAt">, now: Date): "start_deadline" | "total_deadline" | null {
  const d = deadlinesFor(job);
  if (d.start && d.start <= now) return "start_deadline";
  if (d.total && d.total <= now) return "total_deadline";
  return null;
}

export type Claim = { readonly jobId: string; readonly token: number };

// 지금 실행 자리에서 쓴 시간(ms)
const runningMs = (cur: { runStartedAt: Date | null }, now: Date) => (cur.runStartedAt ? Math.max(0, now.getTime() - cur.runStartedAt.getTime()) : 0);
export type Claimed = { job: AutomationJob; claim: Claim };

// 지금 시각(DB 시계). now()는 트랜잭션 시작 시각이라 잠금을 기다리는 사이 흐른 시간이 빠진다(그 사이 lease·마감이 지나도 옛 시각으로 통과).
// 그래서 실제 시각(clock_timestamp)을 쓰고, 시간 판단·연장은 잠금을 잡은 뒤에 이 값으로 한다. SQL 안의 시간 조건도 clock_timestamp()를 쓴다.
export async function dbNow(db: Tx | PrismaClient): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
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
  // 마감이 지난 작업을 닫았으면(각각 커밋) 다음 작업을 다시 고른다
  for (let i = 0; i < 20; i++) {
    const r = await claimOnce(db, workerId, opts);
    if (r !== "closed") return r;
  }
  return null;
}

async function claimOnce(db: PrismaClient, workerId: string, opts: { leaseMs?: number; maxRunning?: number }): Promise<Claimed | null | "closed"> {
  const leaseMs = opts.leaseMs ?? AUTOMATION_LIMITS.leaseMs;
  const maxRunning = opts.maxRunning ?? AUTOMATION_LIMITS.maxRunning;
  return db.$transaction(async (tx) => {
    // 실행 수 세기와 고르기를 한 번에 하나씩 해야 상한을 넘지 않는다(자동 연결 전용 잠금, 주문 처리와 무관).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('automation_claim'))`;
    const running = await tx.automationJob.count({ where: { status: { in: [...LEASED] } } });
    if (running >= maxRunning) return null;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT j.id FROM "AutomationJob" j
      WHERE j.status = 'QUEUED' AND j."runAfter" <= clock_timestamp()
        AND ${quiescentSql("j")}
        AND NOT EXISTS (
          SELECT 1 FROM "AutomationJob" r
          WHERE r."obsTargetKey" = j."obsTargetKey" AND (r.status IN ('RUNNING', 'VERIFYING') OR (r.id <> j.id AND NOT ${quiescentSql("r")})))
      ORDER BY j."runAfter", j."createdAt"
      LIMIT 1
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return null;
    const now = await dbNow(tx);
    const before = await tx.automationJob.findUniqueOrThrow({ where: { id: rows[0].id } });
    // 옛 실행자의 외부 행동이 끝났다고 볼 수 있을 때만 인수한다(격리 창, 후보 고르기와 같은 규칙)
    if (!quiescent(before, now)) return null;
    // 마감(시작 24시간·전체 72시간)이 지난 작업은 실행 자리를 주지 않고 외부 행동 0회로 닫은 뒤 다음 작업을 고른다
    const late = overdue(before, now);
    if (late) {
      await closeOverdue(tx, before, now, late);
      return "closed" as const;
    }
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

// 잠금 순서(자동연결 전체 공통, 교착 방지): 판매자 잠금(lockSellerAutomation) → 작업서 잠금(lockPlaybook) → 작업 행(lockJob·FOR UPDATE)
// → 결제 행. 여러 잠금을 잡는 모든 경로는 이 순서만 쓴다(commitJob·markConnectionRevoked·finishJob·touch·연습 기록).
// 작업 행을 잡은 뒤에 판매자·작업서 잠금을 잡지 않는다.
export type PreLocks = { seller?: boolean; playbook?: "shared" | "exclusive" };

// 작업자의 모든 쓰기는 여기를 거친다. 토큰이 같고, 실행 중 상태이고, lease가 아직 살아 있을 때만 쓴다.
// allowExpiredLease: lease가 막 끝났어도 토큰이 그대로면(아무도 회수·재할당하지 않았으면) 쓴다. 실행 시간 상한 실패처럼
// heartbeat가 일부러 연장을 멈춘 뒤의 마무리 쓰기에만 쓴다. 회수·취소·다른 작업자는 토큰을 올리므로 여전히 막힌다.
async function fencedWrite(
  db: PrismaClient,
  c: Claim,
  build: (now: Date, cur: AutomationJob) => FencedChange,
  // cleanupDone: 되돌리기를 마쳤다(실패로 끝나도 정리 필요 표시를 남기지 않음)
  // preLocks: 작업 행보다 먼저 잡을 잠금(잠금 순서: 판매자 → 작업서 → 작업 행). 판매자·작업서 id는 바뀌지 않는 값이라 잠그기 전에 읽는다
  opts: { allowExpiredLease?: boolean; cleanupDone?: boolean; preLocks?: PreLocks } = {},
): Promise<void> {
  await db.$transaction(async (tx) => {
    if (opts.preLocks) {
      const head = await tx.automationJob.findUnique({ where: { id: c.jobId }, select: { sellerId: true, playbookId: true } });
      if (!head) throw new FencingError();
      if (opts.preLocks.seller) await lockSellerAutomation(tx, head.sellerId);
      if (opts.preLocks.playbook && head.playbookId) await lockPlaybook(tx, head.playbookId, opts.preLocks.playbook);
    }
    await lockJob(tx, c.jobId);
    const now = await dbNow(tx);
    const cur = await tx.automationJob.findUnique({ where: { id: c.jobId } });
    if (!cur) throw new FencingError();
    const built = build(now, cur);
    // 실패로 끝내려는데 바꾼 것이 있으면(되돌리기를 마친 경우 제외) 「정리 필요」로 멈춘다(endStateFor). 결제는 그대로(환불은 정리 뒤)
    const toCleanup = built.to === "FAILED" && endStateFor(cur, "FAILED", { cleanupDone: opts.cleanupDone }) === "CLEANUP_NEEDED";
    const change: FencedChange = toCleanup ? { ...built, to: "CLEANUP_NEEDED", data: { ...built.data, cleanupNeededAt: now }, after: undefined } : built;
    const from = change.to ? sourcesOf(change.to).filter((s) => LEASED.includes(s)) : [...LEASED];
    // 실행 자리를 놓는 전이(대기·재시도·끝)면 이번에 쓴 실행 시간을 합계에 더한다
    const releasing = change.to && !LEASED.includes(change.to);
    const r = await tx.automationJob.updateMany({
      where: { id: c.jobId, fencingToken: c.token, status: { in: from }, ...(opts.allowExpiredLease ? {} : { leaseExpiresAt: { gt: now } }) },
      data: {
        ...change.data,
        ...(change.to ? { status: change.to } : {}),
        ...(releasing ? { activeMsUsed: cur.activeMsUsed + runningMs(cur, now), runStartedAt: null } : {}),
      },
    });
    if (r.count !== 1) throw new FencingError();
    if (change.to && change.to !== cur.status) await writeJobEvent(tx, cur, cur.status, change.to, c.token, change.detail);
    if (toCleanup) await alertCleanupNeeded(tx, cur, change.detail?.reason ?? "failed");
    await change.after?.(tx, cur, now);
  });
}

// 이 작업이 무언가를 바꿨을 수 있는가: 되돌리기와 같은 증거(변경 행동 직전 기록 changedAt·mutatedSteps)로만 판단한다.
// 진행 위치(stepIndex)는 쓰지 않는다(기존 설치를 확인만 하고 단계를 끝낸 작업은 바꾼 것이 없다)
export const hasChanges = (j: Pick<AutomationJob, "changedAt" | "mutatedSteps">) => j.changedAt !== null || j.mutatedSteps.length > 0;

// 단계마다 첫 변경 행동 직전 기록: 작업의 첫 변경 시각(changedAt, 이미 있으면 그대로)과 변경을 시작한 단계(mutatedSteps)를 같은 쓰기로
// 돌려주는 값은 이번 기록이 새로 남긴 것(단계 추가 여부, 새로 남긴 첫 변경 시각). 실행기가 「적용 안 함」으로 거절하면 이것만 되돌린다(unmarkChanged).
export async function markChanged(db: PrismaClient, c: Claim, stepKey: string): Promise<ChangeMark> {
  let mark: ChangeMark = { stepAdded: false, changedAt: null };
  await fencedWrite(db, c, (now, cur) => {
    mark = { stepAdded: !cur.mutatedSteps.includes(stepKey), changedAt: cur.changedAt ? null : now };
    return { data: { changedAt: cur.changedAt ?? now, ...(mark.stepAdded ? { mutatedSteps: [...cur.mutatedSteps, stepKey] } : {}) } };
  });
  return mark;
}

// 실행기가 행동 0회를 보장하는 거절(page_mismatch·pairing_mismatch)을 돌려줬다: 그 행동 직전에 남긴 변경 기록만 같은 작업 행 잠금 아래 되돌린다.
// 이 기록이 새로 남긴 단계·시각만 지우고, 그 전부터 있던 기록(이전 단계·이전 실행의 변경)은 그대로 둔다.
// 실행 자리(lease)를 잃었거나 취소·회수와 겹쳐도 한다(행동 0회는 실행기가 보장): fencing 없이 작업 행 잠금 아래에서 한다.
// 단 그 사이 다른 작업자가 자리를 잡았으면(토큰이 회수·취소 1회보다 더 오름) 그 작업자의 기록일 수 있어 건드리지 않는다.
// 이 기록 때문에 「정리 필요」로 갔는데 되돌린 뒤 바꾼 것이 없으면, 원래 끝(판매자 취소면 취소, 그 밖은 실패)으로 바꾼다.
export async function unmarkChanged(db: PrismaClient, c: Claim, stepKey: string, mark: ChangeMark): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockJob(tx, c.jobId);
    const cur = await tx.automationJob.findUnique({ where: { id: c.jobId } });
    if (!cur || cur.fencingToken > c.token + 1) return;
    const steps = mark.stepAdded ? cur.mutatedSteps.filter((s) => s !== stepKey) : cur.mutatedSteps;
    const ownChangedAt = mark.changedAt !== null && cur.changedAt?.getTime() === mark.changedAt.getTime();
    const changedAt = ownChangedAt && steps.length === 0 ? null : cur.changedAt;
    const reopen = cur.status === "CLEANUP_NEEDED" && !hasChanges({ changedAt, mutatedSteps: steps });
    const end = cur.cancelRequestedAt ? ("CANCELED" as const) : ("FAILED" as const);
    const job = await tx.automationJob.update({
      where: { id: c.jobId },
      data: { mutatedSteps: steps, changedAt, ...(reopen ? { status: end, cleanupNeededAt: null } : {}) },
    });
    if (reopen) await writeJobEvent(tx, job, "CLEANUP_NEEDED", end, job.fencingToken, { reason: "not_applied" });
  });
}

// 바꾼 뒤 실패·취소로 끝나면 조용히 끝내지 않는다: 정리 필요 표시와 마스터 관리자 알림(감사 기록 운영 이벤트)을 같은 트랜잭션에서 남긴다.
// 사람이 쇼핑몰 앱·웹훅·OBS를 정리할 수 있게 하기 위해서다. 자동 되돌리기 전체(E3-W)는 다음 PR.
// 끝내는 상태 결정(실패·취소로 끝나는 모든 경로가 이 함수 하나로 정한다): 바꾼 것이 있으면(되돌리기를 마친 경우 제외)
// 「정리 필요」로 멈춘다. 실패·취소로 끝내면 열린 작업에서 빠져 새 구매·설치가 열리고 보관 자료도 지워지므로, 정리 전에는 끝내지 않는다.
export function endStateFor(
  job: Pick<AutomationJob, "changedAt" | "mutatedSteps">,
  intended: "FAILED" | "CANCELED",
  opts: { cleanupDone?: boolean } = {},
): "FAILED" | "CANCELED" | "CLEANUP_NEEDED" {
  return hasChanges(job) && !opts.cleanupDone ? "CLEANUP_NEEDED" : intended;
}

// 「정리 필요」 마스터 관리자 알림(감사 기록 운영 이벤트) 1건
export async function alertCleanupNeeded(tx: Tx, job: Pick<AutomationJob, "id" | "sellerId">, reason: unknown) {
  await tx.auditLog.create({
    data: { actorType: "SYSTEM", sellerId: job.sellerId, action: "automation.job_cleanup_needed", targetType: "AutomationJob", targetId: job.id, after: { reason: String(reason).slice(0, 200) } },
  });
}

const RELEASE = { leaseOwner: null, leaseExpiresAt: null } as const;

// 작업서 준비 상태 직렬화: 구매는 공유 잠금으로 준비 상태를 다시 계산하고, 화면 이탈 기록은 배타 잠금으로 쓴다(트랜잭션 끝까지).
export const lockPlaybook = (tx: Tx, playbookId: string, mode: "shared" | "exclusive") =>
  mode === "shared"
    ? tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${`automation_playbook:${playbookId}`}))`
    : tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`automation_playbook:${playbookId}`}))`;

// 판매자 단위 자동연결 직렬화: 유료 재설치 결제와 설치 완료 기록이 서로 끼어들지 않게 한다(무료 재연결 판정을 같은 잠금 안에서 다시 계산).
export const lockSellerAutomation = (tx: Tx, sellerId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`automation_seller:${sellerId}`}))`;

// lease 연장 + 쓴 비용·실행 통계(판단 호출 수·작업서 행동 수·화면 이탈 단계) 기록
export type TouchStats = { costUsed: number; plannerCalls?: number; playbookActions?: number; deviatedSteps?: string[]; deviatedNow?: boolean };
// 실행 시간 합계(대기 제외)가 상한을 넘었으면 던진다(touch·heartbeat 때 확인)
function assertRunTime(cur: AutomationJob, now: Date) {
  if (cur.activeMsUsed + runningMs(cur, now) > AUTOMATION_LIMITS.maxRunMs) throw new RunTimeExceeded();
  if (overdue(cur, now) === "total_deadline") throw new RunTimeExceeded("total_deadline");
}

export const touch = (db: PrismaClient, c: Claim, stats: TouchStats, leaseMs: number = AUTOMATION_LIMITS.leaseMs) =>
  fencedWrite(
    db,
    c,
    (now, cur) => (assertRunTime(cur, now), {
    data: {
      costUsed: stats.costUsed,
      ...(stats.plannerCalls !== undefined ? { plannerCalls: stats.plannerCalls } : {}),
      ...(stats.playbookActions !== undefined ? { playbookActions: stats.playbookActions } : {}),
      ...(stats.deviatedSteps !== undefined ? { deviatedSteps: stats.deviatedSteps } : {}),
      ...(stats.deviatedNow ? { lastDeviationAt: now } : {}),
      leaseExpiresAt: plus(now, leaseMs),
    },
  }),
    // 화면 이탈 기록은 그 작업서의 배타 잠금을 잡고 커밋한다(진행 중인 구매가 준비 상태를 다시 계산하는 동안 끼어들지 않게). 작업 행보다 먼저
    stats.deviatedNow ? { preLocks: { playbook: "exclusive" } } : {},
  );

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
// (실행 시간 상한 초과 뒤에는 heartbeat가 연장을 멈추므로 lease가 막 끝났어도 토큰이 그대로면 마무리한다)
export const failWithRefund = (db: PrismaClient, c: Claim, reason: string, opts: { cleanupDone?: boolean } = {}) =>
  fencedWrite(
    db,
    c,
    (now) => ({
      to: "FAILED",
      data: { ...RELEASE, finishedAt: now, lastError: reason },
      detail: { reason },
      after: (tx, cur, at) => markRefundPending(tx, cur, reason, at),
    }),
    { allowExpiredLease: true, cleanupDone: opts.cleanupDone },
  );

// 「정리 필요」: 작업이 만든 변경을 되돌리지 못했다. 실행 자리를 놓고, 같은 트랜잭션에서 마스터 관리자 알림(감사 기록 운영 이벤트)을 남긴다.
// 결제는 그대로 둔다(사람이 정리한 뒤 실패·환불로 닫는다). 보관 자료는 정리 전용으로 남는다(끝난 작업이 아니라 정리 대상이 아님).
export const markCleanupNeeded = (db: PrismaClient, c: Claim, reason: string) =>
  fencedWrite(
    db,
    c,
    (now) => ({
      to: "CLEANUP_NEEDED",
      data: { ...RELEASE, lastError: reason.slice(0, 200), cleanupNeededAt: now },
      detail: { reason: reason.slice(0, 200) },
      after: async (tx, cur) => alertCleanupNeeded(tx, cur, reason),
    }),
    { allowExpiredLease: true },
  );

// 브라우저 상태 보관 직전 「보관 중」 표시(보관본을 놓치지 않게 보관보다 먼저 남긴다)
export const markBrowserStateHeld = (db: PrismaClient, c: Claim) => fencedWrite(db, c, () => ({ data: { browserStateHeld: true } }));

// 같은 PC 잠금을 실제 PC(OBS pairing)로 옮긴다. OBS를 처음 바꾸기 직전에 부른다.
// 그 PC에서 다른 작업이 실행 중이면 부분 유니크(AutomationJob_one_running_per_obs_target)가 막고(P2002) 작업자는 obs_target_busy로 나중에 다시 한다.
// 잠금과 같은 쓰기로 이 작업이 바꿀 PC(obsPairingId)도 남긴다. 첫 변경 직후 작업자가 죽어도 다시 시작한 실행이 이 PC를 기준으로 삼는다.
export const claimObsTarget = (db: PrismaClient, c: Claim, pairingId: string) =>
  fencedWrite(db, c, () => ({ data: { obsTargetKey: `obs:${pairingId.slice(0, 200)}`, obsPairingId: pairingId.slice(0, 200) } }));

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
  fencedWrite(db, c, (now, cur) => ({
    to: "NEEDS_CUSTOMER",
    data: {
      ...RELEASE,
      customerAction: action,
      // 고객 대기 마감: 지금 + 24시간, 단 전체 마감(시작 + 72시간)보다 늦지 않게
      actionDeadlineAt: deadlinesFor(cur).customerActionAt(now),
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
  }),
    // 설치 완료는 판매자 잠금을 잡고 커밋한다(유료 재설치 결제가 무료 재연결 판정을 다시 계산하는 동안 끼어들지 않게). 작업 행보다 먼저
    to === "SUCCEEDED" ? { preLocks: { seller: true } } : {},
  );

// 고객 행동 마감이 지난 대기 작업을 끝낸다(회수와 재개 시도가 같이 쓴다). 바꾼 것이 없으면 실패·전액 환불 처리 대기(확정 ②,
// 실제 환불 실행은 승인 뒤), 있으면 정리 필요(결제는 정리 뒤)
export async function expireCustomerWait(tx: Tx, id: string, now: Date) {
  await closeOverdue(tx, await tx.automationJob.findUniqueOrThrow({ where: { id } }), now, "customer_action_timeout");
}

// 마감이 지난 대기 작업(QUEUED·NEEDS_CUSTOMER)을 실행 없이 끝낸다. 호출하는 쪽이 작업 행을 잠근 상태여야 한다.
// 바꾼 것이 없으면 실패·전액 환불 처리 대기, 있으면 정리 필요(endStateFor). 토큰을 올려 늦은 쓰기를 막는다.
async function closeOverdue(tx: Tx, cur: AutomationJob, now: Date, reason: "customer_action_timeout" | "start_deadline" | "total_deadline") {
  const end = endStateFor(cur, "FAILED");
  const job = await tx.automationJob.update({
    where: { id: cur.id },
    data: { ...RELEASE, status: end, lastError: reason, finishedAt: now, customerAction: null, actionDeadlineAt: null, fencingToken: { increment: 1 }, ...(end === "CLEANUP_NEEDED" ? { cleanupNeededAt: now } : {}) },
  });
  await writeJobEvent(tx, job, cur.status, end, job.fencingToken, { reason });
  if (end === "FAILED") await markRefundPending(tx, job, reason, now);
  else await alertCleanupNeeded(tx, job, reason);
}

// lease가 끝난 실행 중 작업을 회수한다(작업자 중단·멈춤). 토큰을 올려 이전 작업자의 늦은 쓰기를 막는다.
// 고객 행동 마감이 지난 작업은 실패로 닫는다.
export async function reapExpired(db: PrismaClient, random: () => number = Math.random): Promise<{ requeued: number; failed: number }> {
  return db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    let requeued = 0;
    let failed = 0;
    const expired = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AutomationJob"
      WHERE status IN ('RUNNING', 'VERIFYING') AND "leaseExpiresAt" <= clock_timestamp()
      LIMIT 100 FOR UPDATE SKIP LOCKED`;
    for (const { id } of expired) {
      const cur = await tx.automationJob.findUniqueOrThrow({ where: { id } });
      const attempts = cur.attempts + 1;
      const give = attempts >= cur.maxAttempts;
      // 시도를 다 쓴 끝은 endStateFor로(바꾼 것이 있으면 정리 필요)
      const end = endStateFor(cur, "FAILED");
      const job = await tx.automationJob.update({
        where: { id },
        data: {
          ...(give
            ? { ...RELEASE, status: end, attempts, lastError: "lease_expired", finishedAt: now, fencingToken: { increment: 1 }, ...(end === "CLEANUP_NEEDED" ? { cleanupNeededAt: now } : {}) }
            : { ...RELEASE, status: "QUEUED" as const, attempts, lastError: "lease_expired", runAfter: plus(now, backoffMs(attempts, random)), fencingToken: { increment: 1 } }),
          // 멈춘 작업자가 쓴 시간도 실행 시간에 넣는다(lease가 끝난 시각까지)
          activeMsUsed: cur.activeMsUsed + (cur.leaseExpiresAt ? runningMs(cur, cur.leaseExpiresAt) : 0),
          runStartedAt: null,
        },
      });
      await writeJobEvent(tx, job, cur.status, job.status, job.fencingToken, { reason: "lease_expired" });
      if (give && end === "CLEANUP_NEEDED") await alertCleanupNeeded(tx, cur, "lease_expired");
      if (give) failed++;
      else requeued++;
    }
    const waiting = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AutomationJob"
      WHERE status = 'NEEDS_CUSTOMER' AND "actionDeadlineAt" <= clock_timestamp()
      LIMIT 100 FOR UPDATE SKIP LOCKED`;
    for (const { id } of waiting) {
      await expireCustomerWait(tx, id, now);
      failed++;
    }
    // 시작·전체 마감이 지난 대기열 작업(작업자 부족·장애로 실행되지 못함). 후보만 SQL로 고르고 판단은 deadlinesFor로 한다
    const queued = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AutomationJob"
      WHERE status = 'QUEUED' AND (
        ("startedAt" IS NULL AND "queuedAt" <= clock_timestamp() - ${AUTOMATION_LIMITS.startDeadlineMs} * interval '1 millisecond')
        OR "startedAt" <= clock_timestamp() - ${AUTOMATION_LIMITS.totalDeadlineMs} * interval '1 millisecond')
      LIMIT 100 FOR UPDATE SKIP LOCKED`;
    for (const { id } of queued) {
      const cur = await tx.automationJob.findUniqueOrThrow({ where: { id } });
      const late = overdue(cur, now);
      if (!late) continue;
      await closeOverdue(tx, cur, now, late);
      failed++;
    }
    return { requeued, failed };
  });
}
