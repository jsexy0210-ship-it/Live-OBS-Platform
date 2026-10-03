import type { PrismaClient } from "@prisma/client";
import type { BillingProvider } from "../billing/provider";
import { AUTOMATION_LIMITS } from "./config";
import { sanitizeObservation, validateDecision, type ActionOutcome, type ConnectionFacts, type VerificationEvidence, type AutomationRuntime, type BrowserSession, type JobScope } from "./ports";
import { reconcileAutomationPayments } from "./purchase";
import { FencingError, advanceStep, claimNext, finishJob, parkForCustomer, reapExpired, retryLater, toVerifying, touch, type Claimed } from "./queue";
import { STEPS } from "./steps";

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
  const maxActions = opts.maxActionsPerStep ?? AUTOMATION_LIMITS.maxActionsPerStep;
  let session: BrowserSession | null = null;
  let verifying = job.status === "VERIFYING";
  let cost = job.costUsed;
  let evidence: VerificationEvidence | undefined;

  const fail = async (reason: string): Promise<RunResult> => (await finishJob(db, claim, "FAILED", reason), "failed");
  const retry = async (reason: string): Promise<RunResult> => (await retryLater(db, claim, reason, opts.random), "retry");

  try {
    const secrets = await rt.vault.forJob(scope);
    // 무료 재연결은 실제로 연결된 쇼핑몰·PC가 기준 작업과 같아야 한다(요청 값만 믿지 않는다)
    const base =
      job.kind === "RECONNECT_FREE" && job.baseJobId
        ? await db.automationJob.findFirst({ where: { id: job.baseJobId, sellerId: job.sellerId }, select: { shopKey: true, obsPairingId: true } })
        : null;
    for (let stepIndex = job.stepIndex; stepIndex < STEPS.length; stepIndex++) {
      const step = STEPS[stepIndex];
      if (step.kind === "verify" && !verifying) {
        await toVerifying(db, claim);
        verifying = true;
      }
      const history: string[] = [];
      const facts: ConnectionFacts = {};
      let verified = false;
      let done = false;
      for (let i = 0; i < maxActions && !done; i++) {
        const raw = step.kind === "browser" ? await (session ??= await rt.browser.open(scope)).observe() : await rt.obs.observe(scope);
        const decision = await rt.planner.decide({ step, observation: sanitizeObservation(raw, secrets), history });
        cost += Number.isInteger(decision.costWon) && decision.costWon > 0 ? decision.costWon : 0;
        // 비용 기록과 lease 연장을 한 번에(실행 자리를 잃었으면 여기서 멈춘다)
        await touch(db, claim, cost, leaseMs);
        if (cost > job.costLimit) return await fail("cost_limit");
        const check = validateDecision(step, decision, secrets);
        if (!check.ok) return await fail(`unsafe_action:${check.reason}`);
        const action = decision.action;
        history.push(action.type);
        if (action.type === "request_customer") {
          await parkForCustomer(db, claim, action.action);
          return "needs_customer";
        }
        const out: ActionOutcome = step.kind === "browser" ? await session!.perform(action, secrets) : await rt.obs.perform(scope, action);
        if (out.kind === "needs_customer") {
          await parkForCustomer(db, claim, out.action);
          return "needs_customer";
        }
        if (out.kind === "retryable") return await retry(out.reason);
        if (out.kind === "fatal") return await fail(out.reason);
        Object.assign(facts, out.facts);
        if (out.verified) {
          verified = true;
          evidence = out.evidence ?? { verified: true };
        }
        // 검증 단계는 테스트 표시를 실제로 확인한 뒤에만 끝낸다(모델이 끝났다고 해도 넘어가지 않는다)
        if (out.stepDone && (step.kind !== "verify" || verified)) done = true;
      }
      if (!done) return await retry(`step_action_limit:${step.key}`);
      if (base && ((facts.shopKey && facts.shopKey !== base.shopKey) || (facts.obsPairingId && facts.obsPairingId !== base.obsPairingId))) {
        return await fail("reconnect_target_mismatch");
      }
      await advanceStep(db, claim, stepIndex + 1, facts);
    }
    // 검증 단계를 이번 실행에서 통과했어야 완료다(증거 없이 완료하지 않는다)
    if (!evidence) return await retry("verification_missing");
    await finishJob(db, claim, "SUCCEEDED", undefined, evidence);
    return "succeeded";
  } catch (e) {
    // 자리를 잃었으면(만료·취소·다른 작업자) 아무것도 쓰지 않고 멈춘다
    if (e instanceof FencingError) return "fenced";
    try {
      return await retry("worker_error");
    } catch (inner) {
      if (inner instanceof FencingError) return "fenced";
      throw inner;
    }
  } finally {
    await session?.close();
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
