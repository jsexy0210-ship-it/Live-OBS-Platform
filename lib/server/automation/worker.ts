import { Prisma, type PrismaClient } from "@prisma/client";
import type { BillingProvider } from "../billing/provider";
import { AUTOMATION_LIMITS } from "./config";
import { EngineAborted, runSteps } from "./engine";
import { findPlaybook } from "./playbooks";
import type { AutomationRuntime, JobScope } from "./ports";
import { cleanupPracticeArtifacts, playbookReadiness } from "./practice";
import { reconcileAutomationPayments } from "./purchase";
import { FencingError, RunTimeExceeded, advanceStep, claimNext, claimObsTarget, extendLease, failWithRefund, markBrowserStateHeld, markTargetVerified, finishJob, parkForCustomer, reapExpired, retryLater, toVerifying, touch, type Claimed } from "./queue";

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
  let overTime = false;
  const timer = setInterval(() => {
    extend().catch((e) => {
      if (e instanceof RunTimeExceeded) overTime = true;
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
  try {
    // 무료 재연결은 실제로 연결된 쇼핑몰·PC가 기준 작업과 같아야 한다(요청 값만 믿지 않는다)
    const expectFacts =
      job.kind === "RECONNECT_FREE" && job.baseJobId
        ? await db.automationJob.findFirst({ where: { id: job.baseJobId, sellerId: job.sellerId }, select: { shopKey: true, obsPairingId: true } })
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
        await failWithRefund(db, claim, stop);
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
        targetVerified: job.targetVerifiedAt !== null,
        signal: lost.signal,
      },
      {
        touch: (stats) => touch(db, claim, stats, leaseMs),
        enterVerify: () => toVerifying(db, claim),
        stepDone: (next, facts) => advanceStep(db, claim, next, facts),
        targetVerified: (target) => markTargetVerified(db, claim, target),
        holdBrowserState: () => markBrowserStateHeld(db, claim),
        claimObsTarget: (pairingId) => claimObsTarget(db, claim, pairingId),
      },
    );
    switch (result.kind) {
      case "succeeded":
        await finishJob(db, claim, "SUCCEEDED", undefined, result.evidence);
        return "succeeded";
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
        await failWithRefund(db, claim, "run_time_limit");
        return "failed";
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
  const ended = await db.automationJob.findMany({
    where: { artifactsPurgedAt: null, status: { in: ["SUCCEEDED", "FAILED", "CANCELED"] } },
    select: { id: true, sellerId: true },
    orderBy: { updatedAt: "asc" },
    take: limit,
  });
  let purged = 0;
  for (const j of ended) {
    const scope = { sellerId: j.sellerId, jobId: j.id };
    try {
      await rt.browser.discard(scope);
      await rt.obs.discard(scope);
    } catch {
      continue;
    }
    purged += (
      await db.automationJob.updateMany({
        where: { id: j.id, artifactsPurgedAt: null, status: { in: ["SUCCEEDED", "FAILED", "CANCELED"] } },
        data: { artifactsPurgedAt: new Date(), browserStateHeld: false },
      })
    ).count;
  }
  return purged;
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
