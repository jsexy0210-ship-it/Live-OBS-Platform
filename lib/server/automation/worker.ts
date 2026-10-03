import type { PrismaClient } from "@prisma/client";
import type { BillingProvider } from "../billing/provider";
import { AUTOMATION_LIMITS } from "./config";
import { runSteps } from "./engine";
import { findPlaybook } from "./playbooks";
import type { AutomationRuntime, JobScope } from "./ports";
import { reconcileAutomationPayments } from "./purchase";
import { FencingError, advanceStep, claimNext, finishJob, parkForCustomer, reapExpired, retryLater, toVerifying, touch, type Claimed } from "./queue";

// 자동 연결 작업자 진입점. 웹 서버(주문 API)와 다른 프로세스로 띄우는 것을 전제로 한다.
// 실제 프로세스 실행(배포)은 운영 승인 사항이라 1차에는 이 모듈과 테스트만 있다.

export type WorkerOptions = {
  workerId: string;
  leaseMs?: number;
  maxRunning?: number;
  maxActionsPerStep?: number;
  random?: () => number;
};

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
  try {
    // 무료 재연결은 실제로 연결된 쇼핑몰·PC가 기준 작업과 같아야 한다(요청 값만 믿지 않는다)
    const expectFacts =
      job.kind === "RECONNECT_FREE" && job.baseJobId
        ? await db.automationJob.findFirst({ where: { id: job.baseJobId, sellerId: job.sellerId }, select: { shopKey: true, obsPairingId: true } })
        : null;
    const playbook = findPlaybook(job.playbookId);
    // 작업 중 작업서 버전이 바뀌었으면 작업서를 쓰지 않고 판단 모델로만 진행한다(기록의 버전과 실행이 어긋나지 않게)
    const usable = playbook && job.playbookVersion === playbook.version ? playbook : null;
    const result = await runSteps(
      rt,
      scope,
      {
        startIndex: job.stepIndex,
        verifying: job.status === "VERIFYING",
        stats: { costUsed: job.costUsed, plannerCalls: job.plannerCalls, playbookActions: job.playbookActions, deviatedSteps: [...job.deviatedSteps] },
        costLimit: job.costLimit,
        maxActionsPerStep: opts.maxActionsPerStep ?? AUTOMATION_LIMITS.maxActionsPerStep,
        playbook: usable,
        expectFacts,
      },
      {
        touch: (stats) => touch(db, claim, stats, leaseMs),
        enterVerify: () => toVerifying(db, claim),
        stepDone: (next, facts) => advanceStep(db, claim, next, facts),
      },
    );
    switch (result.kind) {
      case "succeeded":
        await finishJob(db, claim, "SUCCEEDED", undefined, result.evidence);
        return "succeeded";
      case "needs_customer":
        await parkForCustomer(db, claim, result.action);
        return "needs_customer";
      case "retry":
        return await retry(result.reason);
      case "failed":
        await finishJob(db, claim, "FAILED", result.reason);
        return "failed";
    }
  } catch (e) {
    // 자리를 잃었으면(만료·취소·다른 작업자) 아무것도 쓰지 않고 멈춘다
    if (e instanceof FencingError) return "fenced";
    try {
      return await retry("worker_error");
    } catch (inner) {
      if (inner instanceof FencingError) return "fenced";
      throw inner;
    }
  }
}

// 작업자 반복: 만료 회수 → 결제 대사 → 작업 하나 실행. 할 일이 없으면 잠깐 쉰다. signal로 멈춘다.
export async function runWorkerLoop(
  db: PrismaClient,
  rt: AutomationRuntime,
  opts: WorkerOptions & { signal: AbortSignal; idleMs?: number; billing?: BillingProvider },
): Promise<void> {
  const idleMs = opts.idleMs ?? 1_000;
  while (!opts.signal.aborted) {
    await reapExpired(db, opts.random);
    if (opts.billing) await reconcileAutomationPayments(db, opts.billing);
    const r = await runOnce(db, rt, opts);
    if (r === "idle") await new Promise((res) => setTimeout(res, idleMs));
  }
}
