import { writeAudit } from "../audit/log";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { BillingProvider } from "../billing/provider";
import { AUTOMATION_LIMITS } from "./config";
import { EngineAborted, ExternalReadTimeout, callPort, runRollback, runSteps, trackedWindow } from "./engine";
import { findPlaybook } from "./playbooks";
import type { AutomationRuntime, JobScope } from "./ports";
import { cleanupPracticeArtifacts, playbookReadiness } from "./practice";
import { reconcileAutomationPayments } from "./purchase";
import { FencingError, RunTimeExceeded, dbNow, hasChanges, markChanged, unmarkChanged, markActionStarted, markActionEnded, markReleaseStarted, quiescent, markCleanupNeeded, advanceStep, claimNext, claimObsTarget, extendLease, failWithRefund, markBrowserStateHeld, markTargetVerified, finishJob, parkForCustomer, reapExpired, retryLater, toVerifying, touch, type Claimed } from "./queue";

// 자동 연결 작업자 진입점. 웹 서버(주문 API)와 다른 프로세스로 띄우는 것을 전제로 한다.
// 실제 프로세스 실행(배포)은 운영 승인 사항이라 1차에는 이 모듈과 테스트만 있다.

export type WorkerOptions = {
  workerId: string;
  leaseMs?: number;
  maxRunning?: number;
  maxActionsPerStep?: number;
  random?: () => number;
};

const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

// lease heartbeat. 연장이 어떤 이유로든 실패하면(자리 잃음·실행 시간 상한·DB 오류) 바로 abort한다:
// 확인된 lease 없이 외부 행동을 계속하면 회수된 작업을 다른 작업자가 같이 실행할 수 있다.
export function startHeartbeat(extend: () => Promise<void>, intervalMs: number) {
  const ctrl = new AbortController();
  // 실행 시간 상한·전체 마감으로 멈췄으면 그 사유(run_time_limit·total_deadline)
  let overTime: string | null = null;
  const timer = setInterval(() => {
    extend().catch((e) => {
      if (e instanceof RunTimeExceeded) overTime = e.message;
      ctrl.abort();
    });
  }, intervalMs);
  return { signal: ctrl.signal, overTime: () => overTime, stop: () => clearInterval(timer) };
}

export type RunResult = "idle" | "succeeded" | "failed" | "needs_customer" | "retry" | "fenced";

export async function runOnce(db: PrismaClient, rt: AutomationRuntime, opts: WorkerOptions): Promise<RunResult> {
  const claimed = await claimNext(db, opts.workerId, { leaseMs: opts.leaseMs, maxRunning: opts.maxRunning });
  if (!claimed) return "idle";
  return executeJob(db, rt, claimed, opts);
}

export async function executeJob(db: PrismaClient, rt: AutomationRuntime, { job, claim }: Claimed, opts: WorkerOptions): Promise<RunResult> {
  const scope: JobScope = { sellerId: job.sellerId, jobId: job.id };
  const leaseMs = opts.leaseMs ?? AUTOMATION_LIMITS.leaseMs;
  const retry = async (reason: string): Promise<RunResult> => (await retryLater(db, claim, reason, opts.random), "retry");
  // heartbeat: 관찰·판단·실행이 오래 걸려도 lease를 따로 주기적으로 연장한다(lease의 1/3마다).
  // 연장이 거부되면(만료·취소·다른 작업자) abort해 다음 외부 행동 전에 멈춘다. 진행 중인 외부 호출 1개는 끝까지 갈 수 있다.
  const beat = startHeartbeat(() => extendLease(db, claim, leaseMs), Math.max(20, Math.floor(leaseMs / 3)));
  const lost = { signal: beat.signal };
  // 외부 호출 격리 창 기록(engine.ts callPort)
  const windowHooks = trackedWindow({
    start: () => markActionStarted(db, claim),
    release: () => markReleaseStarted(db, claim.jobId),
    end: (startedAt) => markActionEnded(db, claim.jobId, startedAt),
  });
  try {
    // 무료 재연결은 실제로 연결된 쇼핑몰·PC가 기준 작업과 같아야 한다(요청 값만 믿지 않는다).
    // 유료 재설치는 요청한 쇼핑몰·PC(targetShopKey·targetObsPairingId)와 같아야 한다(다른 쇼핑몰·PC에 설치하지 않음)
    const expectFacts =
      job.kind === "RECONNECT_FREE" && job.baseJobId
        ? await db.automationJob.findFirst({ where: { id: job.baseJobId, sellerId: job.sellerId }, select: { shopKey: true, obsPairingId: true } })
        : job.kind === "REINSTALL" && job.targetShopKey && job.targetObsPairingId
          ? { shopKey: job.targetShopKey, obsPairingId: job.targetObsPairingId }
          : null;
    const found = findPlaybook(job.playbookId);
    // 작업 중 작업서 버전이 바뀌었으면(새 버전은 연습 검증 전) 새 버전의 허용 규칙·행동으로 실행하지 않는다.
    // 구매 때 검증된 버전을 다시 쓸 수 없으므로 외부 행동 없이 실패·전액 환불 처리 대기로 끝낸다(고객 잘못이 아님).
    // 같은 버전이어도 그 뒤 화면 이탈로 더 이상 검증 상태가 아니면 같은 방식으로 멈춘다(실행 시작마다 확인).
    // 되돌리기 경로(E3-W)가 생기면 이미 변경한 작업은 그쪽으로 보낸다. 지금은 둘 다 실패·전액 환불 처리 대기.
    const stop =
      job.playbookId && (!found || job.playbookVersion !== found.version)
        ? "playbook_version_changed"
        : found && !(await playbookReadiness(db, found)).verified
          ? "playbook_not_verified"
          : null;
    if (stop) {
      try {
        // 아직 아무것도 바꾸지 않았으면 시작 전 실패·전액 환불 대기
        if (!hasChanges(job)) {
          await failWithRefund(db, claim, stop);
          return "failed";
        }
        // 이미 바꿨으면 되돌린 뒤 실패·환불. 되돌리기는 구매 때 버전의 정의로만 한다(없으면 사람이 정리)
        // 변경 시각은 있는데 단계 기록이 없으면(이 기록 도입 전 작업 등) 어디까지 바꿨는지 알 수 없다: 되돌리지 않고 사람에게
        const uncertain = job.changedAt !== null && job.mutatedSteps.length === 0;
        const rolled =
          found && job.playbookVersion === found.version && !uncertain
            ? await runRollback(
                rt,
                scope,
                { playbook: found, shopHost: job.shopHost, stepIndex: job.stepIndex, mutatedSteps: job.mutatedSteps, obsPairingId: job.obsPairingId, signal: lost.signal },
                {
                  touch: () => extendLease(db, claim, leaseMs),
                  ...windowHooks,
                },
              )
            : ({ kind: "cleanup_needed", reason: uncertain ? "rollback_uncertain" : "rollback_definition_missing" } as const);
        if (rolled.kind === "rolled_back") {
          await failWithRefund(db, claim, stop, { cleanupDone: true });
          return "failed";
        }
        await markCleanupNeeded(db, claim, `${stop}:${rolled.reason}`);
        return "failed";
      } catch (inner) {
        if (inner instanceof FencingError) return "fenced";
        throw inner;
      }
    }
    const playbook = found;
    const result = await runSteps(
      rt,
      scope,
      {
        startIndex: job.stepIndex,
        verifying: job.status === "VERIFYING",
        stats: { costUsed: job.costUsed, plannerCalls: job.plannerCalls, playbookActions: job.playbookActions, deviatedSteps: [...job.deviatedSteps] },
        costLimit: job.costLimit,
        maxActionsPerStep: opts.maxActionsPerStep ?? AUTOMATION_LIMITS.maxActionsPerStep,
        playbook,
        shopHost: job.shopHost,
        // 이전 실행에서 이 작업이 OBS를 바꾼 PC(단계 기록). 재설치의 요청 PC 값과는 다르다(실행에서 확인한 값만).
        obsPairingDone: job.kind === "RECONNECT_FREE" ? null : job.obsPairingId,
        expectFacts,
        waitForUnknownTarget: job.kind === "REINSTALL",
        targetVerified: job.targetVerifiedAt !== null,
        signal: lost.signal,
      },
      {
        touch: (stats) => touch(db, claim, stats, leaseMs),
        enterVerify: () => toVerifying(db, claim),
        stepDone: (next, facts) => advanceStep(db, claim, next, facts),
        targetVerified: (target) => markTargetVerified(db, claim, target),
        holdBrowserState: () => markBrowserStateHeld(db, claim),
        markChanged: (stepKey) => markChanged(db, claim, stepKey),
        ...windowHooks,
        unmarkChanged: (stepKey, mark) => unmarkChanged(db, claim, stepKey, mark),
        claimObsTarget: (pairingId) => claimObsTarget(db, claim, pairingId),
      },
    );
    switch (result.kind) {
      case "succeeded": {
        // 성공 확정 전에 연결한 쇼핑몰과 PC 식별값이 둘 다 저장됐는지 확인한다. 하나라도 없으면 무료 재연결·재설치 판정을 할 수 없으므로
        // 성공이 아니라 확인 실패다(변경이 있었으면 실패 경로의 정리 필요 표시·알림이 붙는다)
        const saved = await db.automationJob.findUnique({ where: { id: job.id }, select: { shopKey: true, obsPairingId: true } });
        if (!saved?.shopKey || !saved.obsPairingId) {
          await finishJob(db, claim, "FAILED", saved?.shopKey ? "pc_identity_unverified" : "shop_identity_unverified");
          return "failed";
        }
        await finishJob(db, claim, "SUCCEEDED", undefined, result.evidence);
        return "succeeded";
      }
      case "needs_customer":
        await parkForCustomer(db, claim, result.action, result.heldBrowserState === true);
        return "needs_customer";
      case "retry":
        return await retry(result.reason);
      case "failed":
        await finishJob(db, claim, "FAILED", result.reason);
        return "failed";
    }
  } catch (e) {
    // 실행 시간 합계(대기 제외)가 6시간을 넘었다: 실패로 끝내고 전액 환불 처리 대기(정본 d6e22c4)
    if (e instanceof RunTimeExceeded || (e instanceof EngineAborted && beat.overTime())) {
      try {
        await failWithRefund(db, claim, e instanceof RunTimeExceeded ? e.message : (beat.overTime() ?? "run_time_limit"));
        return "failed";
      } catch (inner) {
        if (inner instanceof FencingError) return "fenced";
        throw inner;
      }
    }
    // 읽기 포트 호출이 상한을 넘겼다: 이 작업은 다시 시도로 돌리고 작업자는 다음 일을 한다
    if (e instanceof ExternalReadTimeout) {
      try {
        return await retry("read_timeout");
      } catch (inner) {
        if (inner instanceof FencingError) return "fenced";
        throw inner;
      }
    }
    // 자리를 잃었으면(만료·취소·다른 작업자) 아무것도 쓰지 않고 멈춘다
    if (e instanceof FencingError || e instanceof EngineAborted) return "fenced";
    // 알게 된 OBS pairing에서 다른 작업이 이미 실행 중이다(같은 PC 잠금 충돌): 나중에 다시
    if (isUniqueViolation(e)) {
      try {
        return await retry("obs_target_busy");
      } catch (inner) {
        if (inner instanceof FencingError) return "fenced";
        throw inner;
      }
    }
    try {
      return await retry("worker_error");
    } catch (inner) {
      if (inner instanceof FencingError) return "fenced";
      throw inner;
    }
  } finally {
    beat.stop();
  }
}

// 끝난 모든 작업(완료·취소·실패·고객 행동 마감·실행 시간 마감)의 보관 자료(브라우저 상태·임시 파일·행동 키 기록·OBS 연결 정보)
// 삭제를 실행기·로컬 도구에 요청한다. 고객 대기가 없었던 작업도 포함한다. 판매자 취소처럼 작업자 밖에서 끝난 작업도 여기서 지운다.
// 삭제 요청이 실패하면 표시가 남아 다음 반복에서 다시 한다.
export async function purgeEndedBrowserState(db: PrismaClient, rt: Pick<AutomationRuntime, "browser" | "obs">, limit = 50): Promise<number> {
  const now = await dbNow(db);
  // 삭제가 실패한 작업은 다음 재시도 시각까지 고르지 않는다(실패 행만 계속 골라 뒤의 작업에 닿지 못하는 일 방지)
  const ended = await db.automationJob.findMany({
    where: {
      artifactsPurgedAt: null,
      status: { in: ["SUCCEEDED", "FAILED", "CANCELED"] },
      OR: [{ artifactsPurgeRetryAt: null }, { artifactsPurgeRetryAt: { lte: now } }],
    },
    select: { id: true, sellerId: true, artifactsPurgeAttempts: true, lastActionStartedAt: true, lastActionEndedAt: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  let purged = 0;
  for (const j of ended) {
    // 끝난 작업이라도 옛 실행자의 외부 행동이 아직 끝났다고 볼 수 없으면(격리 창) 지우지 않고 다음 반복에서 다시 본다
    if (!quiescent(j, now)) continue;
    // 삭제 대상은 한 작업자만 잡는다: 다음 재시도 시각을 두 삭제 요청의 상한 + 여유 뒤로 미루는 조건부 갱신이 점유다
    // (다른 작업자는 그 시각까지 고르지 않는다. 작업자가 죽으면 그 뒤 다시 잡힌다)
    const claimed = await db.automationJob.updateMany({
      where: { id: j.id, artifactsPurgedAt: null, OR: [{ artifactsPurgeRetryAt: null }, { artifactsPurgeRetryAt: { lte: now } }] },
      data: { artifactsPurgeRetryAt: new Date(now.getTime() + PURGE_CLAIM_MS()) },
    });
    if (claimed.count !== 1) continue;
    const scope = { sellerId: j.sellerId, jobId: j.id };
    // 삭제 요청도 포트 호출 계약을 거친다: 상한을 넘기거나 오류면 삭제 실패로 기록하고 다음 작업으로 넘어간다(작업자가 묶이지 않음)
    const browser = await callPort((signal) => rt.browser.discard(scope, signal));
    const obs = browser.ok ? await callPort((signal) => rt.obs.discard(scope, signal)) : browser;
    if (!obs.ok) {
      await recordPurgeFailure(db, j.id, j.sellerId, j.artifactsPurgeAttempts + 1);
      continue;
    }
    purged += (
      await db.automationJob.updateMany({
        where: { id: j.id, artifactsPurgedAt: null, status: { in: ["SUCCEEDED", "FAILED", "CANCELED"] } },
        data: { artifactsPurgedAt: await dbNow(db), browserStateHeld: false, artifactsPurgeRetryAt: null },
      })
    ).count;
  }
  return purged;
}

// 보관 자료 삭제 반복 실패: 이 횟수부터 마스터 관리자 알림(감사 기록 운영 이벤트, 작업당 1건). 재시도는 늦춰 가며 계속한다.
export const PURGE_ALERT_AFTER = 10;
// 삭제 점유 시간: 두 삭제 요청의 상한 + 여유
const PURGE_CLAIM_MS = () => 2 * AUTOMATION_LIMITS.actionTimeoutMs + AUTOMATION_LIMITS.actionQuiesceGraceMs;
const PURGE_MAX_BACKOFF_MS = 60 * 60_000;

async function recordPurgeFailure(db: PrismaClient, jobId: string, sellerId: string, attempts: number) {
  await db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const retryAt = new Date(now.getTime() + Math.min(30_000 * 2 ** Math.min(attempts - 1, 10), PURGE_MAX_BACKOFF_MS));
    await tx.automationJob.updateMany({ where: { id: jobId, artifactsPurgedAt: null }, data: { artifactsPurgeAttempts: attempts, artifactsPurgeRetryAt: retryAt } });
    if (attempts < PURGE_ALERT_AFTER) return;
    const first = await tx.automationJob.updateMany({ where: { id: jobId, artifactsPurgedAt: null, artifactsPurgeAlertedAt: null }, data: { artifactsPurgeAlertedAt: now } });
    if (first.count === 1) {
      await writeAudit(tx, {
        actorType: "SYSTEM",
        sellerId,
        action: "automation.artifacts_purge_failed",
        targetType: "AutomationJob",
        targetId: jobId,
        after: { attempts },
      });
    }
  });
}

// 작업자 반복: 만료 회수 → 보관본 삭제 → 결제 대사 → 작업 하나 실행. 할 일이 없으면 잠깐 쉰다. signal로 멈춘다.
export async function runWorkerLoop(
  db: PrismaClient,
  rt: AutomationRuntime,
  opts: WorkerOptions & { signal: AbortSignal; idleMs?: number; billing?: BillingProvider },
): Promise<void> {
  const idleMs = opts.idleMs ?? 1_000;
  while (!opts.signal.aborted) {
    await reapExpired(db, opts.random);
    await purgeEndedBrowserState(db, rt);
    await cleanupPracticeArtifacts(db, rt);
    if (opts.billing) await reconcileAutomationPayments(db, opts.billing);
    const r = await runOnce(db, rt, opts);
    if (r === "idle") await new Promise((res) => setTimeout(res, idleMs));
  }
}
