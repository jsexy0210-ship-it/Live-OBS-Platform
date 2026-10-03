import { cueMatches, matchException, type Playbook } from "./playbook";
import {
  hostAllowed,
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

// deviatedNow: 이번 행동에서 화면 이탈이 새로 생겼다(다음 기록 때 lastDeviationAt을 남기고 지운다)
export type EngineStats = { costUsed: number; plannerCalls: number; playbookActions: number; deviatedSteps: string[]; deviatedNow?: boolean };

export type EngineHooks = {
  // 행동마다(비용·통계 기록 + lease 연장). 실행 자리를 잃었으면 던진다.
  touch(stats: EngineStats): Promise<void>;
  enterVerify(): Promise<void>;
  // 무료 재연결 대조를 통과했다(그때의 쇼핑몰·PC). 재시도 때 브라우저 단계를 다시 하지 않으면 이 기록을 쓴다.
  targetVerified?(target: { shopKey: string; obsPairingId: string }): Promise<void>;
  stepDone(nextIndex: number, facts: ConnectionFacts): Promise<void>;
};

export type EngineResult =
  | { kind: "succeeded"; evidence: VerificationEvidence }
  // heldBrowserState: 이 작업의 브라우저 상태를 실행기에 암호화 보관했다(작업이 끝나면 서버가 지운다)
  | { kind: "needs_customer"; action: AutomationCustomerAction; heldBrowserState?: boolean }
  | { kind: "retry"; reason: string }
  | { kind: "failed"; reason: string };

// 실행 자리를 잃었을 때(heartbeat 실패·취소) 다음 외부 행동 전에 멈추려고 던진다.
export class EngineAborted extends Error {
  constructor() {
    super("engine_aborted");
  }
}

// 바꾸는 행동. 무료 재연결의 쇼핑몰·PC 대조는 이 행동을 처음 하기 바로 전에 한다(이동·고객 로그인 대기·관찰·확인은 대조 전에 허용).
const MUTATING: readonly AutomationAction["type"][] = ["click", "fill", "obs_add_overlay_source", "obs_apply_display_settings", "send_test_event"];

export type EngineOptions = {
  // 실행 자리를 잃으면 abort된다. 외부 호출(관찰·판단·실행) 직전마다 확인한다.
  signal?: AbortSignal;
  // 고객 행동 대기로 멈출 때 브라우저 상태를 보관할지(기본 true). 연습 실행은 보관하지 않는다.
  keepBrowserStateOnWait?: boolean;
  // 이전 실행에서 무료 재연결 대조를 통과했다(작업 행 기록). 브라우저 단계부터 다시 하지 않으면 다시 대조하지 않는다.
  targetVerified?: boolean;
  // 비밀값을 넣어도 되는 칸을 정하는 작업서(작업 중 버전이 바뀌어 정해진 행동은 안 쓰더라도 비밀 칸 목록은 그 작업서 것을 쓴다). 없으면 playbook
  secretPlaybook?: Playbook | null;
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
  let session: BrowserSession | null = null;
  let result: EngineResult | null = null;
  const guard = () => {
    if (opts.signal?.aborted) throw new EngineAborted();
  };
  const keep = () => result?.kind === "needs_customer" && opts.keepBrowserStateOnWait !== false && session !== null;
  try {
    result = await runAll(rt, scope, opts, hooks, guard, (s) => (session = s), () => session);
    if (result.kind === "needs_customer" && keep()) result = { ...result, heldBrowserState: true };
    return result;
  } finally {
    // 고객 행동 대기면 이 작업의 로그인·승인 상태를 암호화 보관해 재개 때 이어 간다. 그 밖에는 모두 지운다.
    await (session as BrowserSession | null)?.close({ keepForResume: keep() });
  }
}

async function runAll(
  rt: AutomationRuntime,
  scope: JobScope,
  opts: EngineOptions,
  hooks: EngineHooks,
  guard: () => void,
  setSession: (s: BrowserSession) => void,
  getSession: () => BrowserSession | null,
): Promise<EngineResult> {
  const stats = opts.stats;
  const browser = async () => {
    let s = getSession();
    if (!s) {
      guard();
      s = await rt.browser.open(scope);
      setSession(s);
    }
    return s;
  };
  let verifying = opts.verifying;
  let evidence: VerificationEvidence | undefined;
  const secrets = await rt.vault.forJob(scope);
  // 무료 재연결: 무엇이든 바꾸기 전에 실제로 연결된 쇼핑몰·PC가 기준 작업과 같은지 읽기만으로 확인한다.
  // 고객 로그인 전에는 쇼핑몰을 알 수 없으므로, 첫 변경 행동 바로 전에 한다. 알 수 없으면 무료로 진행하지 않는다.
  const want = opts.expectFacts;
  let targetChecked = !want || (opts.targetVerified === true && STEPS[opts.startIndex]?.kind !== "browser");
  const checkTarget = async (): Promise<EngineResult | null> => {
    if (targetChecked || !want) return null;
    const session = await browser();
    guard();
    const [shopKey, obsPairingId] = await Promise.all([session.currentShopKey(), rt.obs.currentPairingId(scope)]);
    if (!shopKey || !obsPairingId || !want.shopKey || !want.obsPairingId) return { kind: "failed", reason: "reconnect_target_unverified" };
    if (shopKey !== want.shopKey || obsPairingId !== want.obsPairingId) return { kind: "failed", reason: "reconnect_target_mismatch" };
    targetChecked = true;
    await hooks.targetVerified?.({ shopKey, obsPairingId });
    return null;
  };
  const secretBook = opts.secretPlaybook === undefined ? opts.playbook : opts.secretPlaybook;
  const touchStats = async () => {
    await hooks.touch(stats);
    stats.deviatedNow = false;
  };
  for (let stepIndex = opts.startIndex; stepIndex < STEPS.length; stepIndex++) {
    const step = STEPS[stepIndex];
    if (step.kind === "verify" && !verifying) {
      await hooks.enterVerify();
      verifying = true;
    }
    const pb = opts.playbook?.steps[step.key] ?? null;
    const secretTargets = secretBook?.steps[step.key]?.secretTargets ?? {};
    const scripted = pb ? [...pb.actions] : [];
    let deviated = !pb;
    const history: string[] = [];
    const facts: ConnectionFacts = {};
    let verified = false;
    let done = false;
    for (let i = 0; i < opts.maxActionsPerStep && !done; i++) {
      const session = step.kind === "browser" ? await browser() : null;
      guard();
      const raw = session ? await session.observe() : await rt.obs.observe(scope);
      const exception = pb ? matchException(pb, raw) : null;
      if (exception) {
        await touchStats();
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
          stats.deviatedNow = true;
        }
      }
      if (!action) {
        const reference = pb ? { guide: pb.guide, examples: pb.examples, referenceImages: pb.referenceImages } : null;
        guard();
        const decision = await rt.planner.decide({ step, observation: sanitizeObservation(raw, secrets), history, reference });
        stats.plannerCalls++;
        costWon = Number.isInteger(decision.costWon) && decision.costWon > 0 ? decision.costWon : 0;
        const check = validateDecision(step, decision, secrets, secretTargets);
        stats.costUsed += costWon;
        await touchStats();
        if (stats.costUsed > opts.costLimit) return { kind: "failed", reason: "cost_limit" };
        if (!check.ok) return { kind: "failed", reason: `unsafe_action:${check.reason}` };
        action = decision.action;
      } else {
        // 작업서 행동도 같은 검사를 거친다(작업서가 잘못돼도 허용 밖 행동은 하지 않음)
        const check = validateDecision(step, { action, costWon: 0 }, secrets, secretTargets);
        await touchStats();
        if (!check.ok) return { kind: "failed", reason: `unsafe_action:${check.reason}` };
      }
      history.push(action.type);
      if (action.type === "request_customer") return { kind: "needs_customer", action: action.action };
      if (MUTATING.includes(action.type)) {
        const blocked = await checkTarget();
        if (blocked) return blocked;
      }
      // 비밀값 입력은 승인 때 관찰한 주소와 실행 직전 실제 문서 주소가 모두 허용 호스트여야 한다(리다이렉트로 다른 출처에 간 경우 차단)
      if (action.type === "fill" && "secretRef" in action.value) {
        guard();
        const here = session ? await session.currentUrl() : null;
        if (!raw.url || !hostAllowed(raw.url) || !here || !hostAllowed(here)) return { kind: "failed", reason: "unsafe_action:secret_origin_not_allowed" };
      }
      guard();
      const out: ActionOutcome = session ? await session.perform(action, secrets) : await rt.obs.perform(scope, action);
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
    // 단계 결과로도 다시 확인(진행 중 다른 쇼핑몰·PC로 바뀐 경우)
    if (want && ((facts.shopKey && facts.shopKey !== want.shopKey) || (facts.obsPairingId && facts.obsPairingId !== want.obsPairingId))) {
      return { kind: "failed", reason: "reconnect_target_mismatch" };
    }
    // 마지막(검증) 단계는 여기서 진행 위치를 넘기지 않는다. 완료 기록(finishJob)이 검증 증거와 함께 한 번에 넘긴다
    // (그 사이 작업자가 멈춰도 다시 잡은 작업자가 검증 단계부터 다시 해 증거를 다시 얻는다).
    if (stepIndex < STEPS.length - 1) await hooks.stepDone(stepIndex + 1, facts);
    else if (facts.shopKey || facts.obsPairingId) await hooks.stepDone(stepIndex, facts);
  }
  // 검증 단계를 이번 실행에서 통과했어야 완료다(증거 없이 완료하지 않는다)
  if (!evidence) return { kind: "retry", reason: "verification_missing" };
  return { kind: "succeeded", evidence };
}
