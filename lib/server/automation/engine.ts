import { cueMatches, matchException, type Playbook } from "./playbook";
import {
  sanitizeObservation,
  validateDecision,
  type ActionOutcome,
  type AutomationAction,
  type AutomationRuntime,
  type BrowserSession,
  type ConnectionFacts,
  type JobScope,
  type VerificationEvidence,
} from "./ports";
import { STEPS } from "./steps";
import type { AutomationCustomerAction } from "@prisma/client";

// 단계 실행 엔진. 고객 작업(worker.ts)과 연습 실행(practice.ts)이 같이 쓴다. DB 쓰기는 hooks로만 한다.
// 단계마다: 화면 관찰 → 작업서 예외 화면 확인 → 작업서 다음 행동의 화면 단서가 맞으면 그 행동을 그대로 실행(판단 호출 없음)
// → 단서가 다르면(화면 이탈) 그 단계 남은 부분은 판단 모델이 작업서 설명·성공 사례를 참고해 고른다.
// 어느 쪽이든 실행 전에 같은 검사(validateDecision)를 거친다.

export type EngineStats = { costUsed: number; plannerCalls: number; playbookActions: number; deviatedSteps: string[] };

export type EngineHooks = {
  // 행동마다(비용·통계 기록 + lease 연장). 실행 자리를 잃었으면 던진다.
  touch(stats: EngineStats): Promise<void>;
  enterVerify(): Promise<void>;
  stepDone(nextIndex: number, facts: ConnectionFacts): Promise<void>;
};

export type EngineResult =
  | { kind: "succeeded"; evidence: VerificationEvidence }
  | { kind: "needs_customer"; action: AutomationCustomerAction }
  | { kind: "retry"; reason: string }
  | { kind: "failed"; reason: string };

export type EngineOptions = {
  startIndex: number;
  verifying: boolean;
  stats: EngineStats;
  costLimit: number;
  maxActionsPerStep: number;
  playbook: Playbook | null;
  // 무료 재연결: 실제 연결된 쇼핑몰·PC가 이 값과 같아야 한다
  expectFacts?: { shopKey: string | null; obsPairingId: string | null } | null;
};

export async function runSteps(rt: AutomationRuntime, scope: JobScope, opts: EngineOptions, hooks: EngineHooks): Promise<EngineResult> {
  const stats = opts.stats;
  let verifying = opts.verifying;
  let evidence: VerificationEvidence | undefined;
  let session: BrowserSession | null = null;
  try {
    const secrets = await rt.vault.forJob(scope);
    for (let stepIndex = opts.startIndex; stepIndex < STEPS.length; stepIndex++) {
      const step = STEPS[stepIndex];
      if (step.kind === "verify" && !verifying) {
        await hooks.enterVerify();
        verifying = true;
      }
      const pb = opts.playbook?.steps[step.key] ?? null;
      const scripted = pb ? [...pb.actions] : [];
      let deviated = !pb;
      const history: string[] = [];
      const facts: ConnectionFacts = {};
      let verified = false;
      let done = false;
      for (let i = 0; i < opts.maxActionsPerStep && !done; i++) {
        const raw = step.kind === "browser" ? await (session ??= await rt.browser.open(scope)).observe() : await rt.obs.observe(scope);
        const exception = pb ? matchException(pb, raw) : null;
        if (exception) {
          await hooks.touch(stats);
          if ("customerAction" in exception) return { kind: "needs_customer", action: exception.customerAction };
          if ("retry" in exception) return { kind: "retry", reason: exception.retry };
          return { kind: "failed", reason: exception.fail };
        }
        let action: AutomationAction | null = null;
        let costWon = 0;
        if (!deviated && scripted.length > 0) {
          if (cueMatches(scripted[0].expect, raw)) {
            action = scripted.shift()!.action;
            stats.playbookActions++;
          } else {
            // 화면이 작업서와 다르다: 관리 화면 변경 신호. 재검증 대상이 된다(practice.ts).
            deviated = true;
            if (!stats.deviatedSteps.includes(step.key)) stats.deviatedSteps.push(step.key);
          }
        }
        if (!action) {
          const reference = pb ? { guide: pb.guide, examples: pb.examples, referenceImages: pb.referenceImages } : null;
          const decision = await rt.planner.decide({ step, observation: sanitizeObservation(raw, secrets), history, reference });
          stats.plannerCalls++;
          costWon = Number.isInteger(decision.costWon) && decision.costWon > 0 ? decision.costWon : 0;
          const check = validateDecision(step, decision, secrets);
          stats.costUsed += costWon;
          await hooks.touch(stats);
          if (stats.costUsed > opts.costLimit) return { kind: "failed", reason: "cost_limit" };
          if (!check.ok) return { kind: "failed", reason: `unsafe_action:${check.reason}` };
          action = decision.action;
        } else {
          // 작업서 행동도 같은 검사를 거친다(작업서가 잘못돼도 허용 밖 행동은 하지 않음)
          const check = validateDecision(step, { action, costWon: 0 }, secrets);
          await hooks.touch(stats);
          if (!check.ok) return { kind: "failed", reason: `unsafe_action:${check.reason}` };
        }
        history.push(action.type);
        if (action.type === "request_customer") return { kind: "needs_customer", action: action.action };
        const out: ActionOutcome = step.kind === "browser" ? await session!.perform(action, secrets) : await rt.obs.perform(scope, action);
        if (out.kind === "needs_customer") return { kind: "needs_customer", action: out.action };
        if (out.kind === "retryable") return { kind: "retry", reason: out.reason };
        if (out.kind === "fatal") return { kind: "failed", reason: out.reason };
        Object.assign(facts, out.facts);
        if (out.verified) {
          verified = true;
          evidence = out.evidence ?? { verified: true };
        }
        // 검증 단계는 테스트 표시를 실제로 확인한 뒤에만 끝낸다(모델·작업서가 끝났다고 해도 넘어가지 않는다)
        if (out.stepDone && (step.kind !== "verify" || verified)) done = true;
        // 작업서 끝 행동(step_done)까지 했는데 끝나지 않았다면 남은 부분은 판단 모델로
        if (!done && !deviated && scripted.length === 0) deviated = true;
      }
      if (!done) return { kind: "retry", reason: `step_action_limit:${step.key}` };
      const want = opts.expectFacts;
      if (want && ((facts.shopKey && facts.shopKey !== want.shopKey) || (facts.obsPairingId && facts.obsPairingId !== want.obsPairingId))) {
        return { kind: "failed", reason: "reconnect_target_mismatch" };
      }
      await hooks.stepDone(stepIndex + 1, facts);
    }
    // 검증 단계를 이번 실행에서 통과했어야 완료다(증거 없이 완료하지 않는다)
    if (!evidence) return { kind: "retry", reason: "verification_missing" };
    return { kind: "succeeded", evidence };
  } finally {
    await session?.close();
  }
}
