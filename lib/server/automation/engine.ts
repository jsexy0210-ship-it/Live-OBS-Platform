import { createHash } from "node:crypto";
import { cueMatches, matchException, navRulesFor, resolveShop, type Playbook } from "./playbook";
import {
  sanitizeObservation,
  secretOriginAllowed,
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
  // OBS를 처음 바꾸기 직전: 같은 PC 잠금을 실제 PC(OBS pairing)로 옮긴다. 다른 작업이 그 PC에서 실행 중이면 던진다.
  claimObsTarget?(pairingId: string): Promise<void>;
  // 브라우저 상태를 보관하기 직전(「보관 중」 표시를 먼저 남긴다). 실패하면 보관하지 않는다.
  holdBrowserState?(): Promise<void>;
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

// 키 순서와 무관한 직렬화(같은 의미의 행동이면 같은 문자열)
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export function actionKeyOf(jobId: string, stepIndex: number, action: AutomationAction): string {
  return `${jobId}:${stepIndex}:${createHash("sha256").update(stableJson(action)).digest("hex").slice(0, 32)}`;
}

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
  // 작업 대상 쇼핑몰 호스트(판매자가 낸 주소). 비밀값은 이 호스트의 관리자 경로에서만 넣는다. 없으면 비밀값을 쓰지 못한다.
  shopHost?: string | null;
  // 이 작업이 이전 실행에서 이미 OBS를 바꾼 PC(작업 행 기록). 이번 실행에서 다른 PC가 보이면 두 PC에 나눠 설치하지 않게 멈춘다.
  obsPairingDone?: string | null;
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
  let held = false;
  try {
    result = await runAll(rt, scope, opts, hooks, guard, (s) => (session = s), () => session);
    if (result.kind === "needs_customer" && opts.keepBrowserStateOnWait !== false && session !== null) {
      // 보관하기 전에 「보관 중」 표시를 먼저 남긴다(fenced). 그 뒤 취소·fencing이 일어나도 표시가 남아 서버가 반드시 지운다.
      // 표시를 남기지 못하면 보관하지 않고 지운 뒤 오류를 그대로 올린다: 자리를 잃었으면 작업자가 멈추고,
      // 일시적인 오류면 다시 시도한다(보관본 없이 고객 대기로 두지 않는다).
      await hooks.holdBrowserState?.();
      held = true;
      result = { ...result, heldBrowserState: true };
    }
    return result;
  } finally {
    // 고객 행동 대기면 이 작업의 로그인·승인 상태를 암호화 보관해 재개 때 이어 간다. 그 밖에는 모두 지운다.
    await (session as BrowserSession | null)?.close({ keepForResume: held });
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
  // 쇼핑몰 대조는 기록(targetVerified)이 있고 브라우저 단계부터 다시 하지 않으면 다시 하지 않는다.
  // PC(OBS pairing) 대조는 실행을 이어 갈 때마다 첫 변경 행동 전에 다시 한다(그사이 PC가 바뀔 수 있음).
  let shopChecked = !want || (opts.targetVerified === true && STEPS[opts.startIndex]?.kind !== "browser");
  let pcChecked = !want;
  const checkTarget = async (): Promise<EngineResult | null> => {
    if (!want || (shopChecked && pcChecked)) return null;
    if (!want.shopKey || !want.obsPairingId) return { kind: "failed", reason: "reconnect_target_unverified" };
    let shopKey: string | null = want.shopKey;
    if (!shopChecked) {
      const session = await browser();
      guard();
      shopKey = await session.currentShopKey();
    }
    guard();
    const obsPairingId = await rt.obs.currentPairingId(scope);
    if (!shopKey || !obsPairingId) return { kind: "failed", reason: "reconnect_target_unverified" };
    if (shopKey !== want.shopKey || obsPairingId !== want.obsPairingId) return { kind: "failed", reason: "reconnect_target_mismatch" };
    if (!shopChecked) await hooks.targetVerified?.({ shopKey, obsPairingId });
    shopChecked = true;
    pcChecked = true;
    return null;
  };
  const secretBook = opts.secretPlaybook === undefined ? opts.playbook : opts.secretPlaybook;
  // 같은 PC 잠금은 실행마다 OBS를 처음 바꾸기 전에 로컬 도구로 확인한 실제 PC로 잡는다(요청 값·이전 기록을 믿지 않음)
  let obsTargetClaimed = false;
  // 이 작업이 OBS를 바꾼 PC. 다른 PC가 보이면 한 작업이 두 PC에 나뉘어 설치되지 않게 멈춘다.
  let obsPairing: string | null = opts.obsPairingDone ?? null;
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
    const allowedTargets = secretBook?.steps[step.key]?.allowedTargets ?? [];
    const nav = navRulesFor(secretBook?.steps[step.key], opts.shopHost);
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
          action = resolveShop(scripted.shift()!.action, opts.shopHost);
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
        const check = validateDecision(step, decision, secrets, secretTargets, allowedTargets, nav);
        stats.costUsed += costWon;
        await touchStats();
        if (stats.costUsed > opts.costLimit) return { kind: "failed", reason: "cost_limit" };
        if (!check.ok) return { kind: "failed", reason: `unsafe_action:${check.reason}` };
        action = decision.action;
      } else {
        // 작업서 행동도 같은 검사를 거친다(작업서가 잘못돼도 허용 밖 행동은 하지 않음)
        const check = validateDecision(step, { action, costWon: 0 }, secrets, secretTargets, allowedTargets, nav);
        await touchStats();
        if (!check.ok) return { kind: "failed", reason: `unsafe_action:${check.reason}` };
      }
      history.push(action.type);
      if (action.type === "request_customer") return { kind: "needs_customer", action: action.action };
      const mutating = MUTATING.includes(action.type);
      if (mutating) {
        const blocked = await checkTarget();
        if (blocked) return blocked;
      }
      // OBS 쪽 행동은 바꾸기·검증 읽기·단계 끝 모두 직전마다(모든 작업) 실제 PC를 새로 읽는다. 무료 재연결은 기준 PC와 다르면 멈춘다(앞선 대조 기록을 믿지 않음).
      // 이미 한 PC에 바꾼 뒤 PC가 바뀌었으면 두 PC에 나눠 설치하거나 다른 PC의 증거로 완료하지 않게 멈춘다.
      // 이번 실행에서 처음 바꾸기 전에는 같은 PC 잠금을 그 PC로 옮긴다(다른 작업이 그 PC를 쓰고 있으면 claimObsTarget이 던져 obs_target_busy)
      if (!session) {
        guard();
        const pairingId = await rt.obs.currentPairingId(scope);
        if (!pairingId) return want ? { kind: "failed", reason: "reconnect_target_unverified" } : { kind: "needs_customer", action: "LOCAL_TOOL" };
        if (want && pairingId !== want.obsPairingId) return { kind: "failed", reason: "reconnect_target_mismatch" };
        if (obsPairing && pairingId !== obsPairing) return { kind: "failed", reason: "obs_target_changed" };
        if (mutating) {
          if (!obsTargetClaimed && hooks.claimObsTarget) {
            await hooks.claimObsTarget(pairingId);
            obsTargetClaimed = true;
          }
          obsPairing = pairingId;
        }
      }
      // 비밀값 입력은 승인 때 관찰한 주소와 실행 직전 실제 문서 주소가 모두 작업 대상 쇼핑몰의 관리자 경로여야 하고,
      // 관찰한 화면에 관리자 로그인 상태 단서가 있어야 한다(리다이렉트로 다른 출처·같은 호스트의 쇼핑몰 앞 화면에 간 경우 차단)
      if (action.type === "fill" && "secretRef" in action.value) {
        guard();
        const here = session ? await session.currentUrl() : null;
        const origin = secretBook?.secretOrigin;
        const ok = (u: string | null) => !!u && !!origin && secretOriginAllowed(u, opts.shopHost, origin.pathPrefixes);
        if (!origin || !ok(raw.url) || !ok(here) || !cueMatches(origin.adminCue, raw)) return { kind: "failed", reason: "unsafe_action:secret_origin_not_allowed" };
      }
      guard();
      // 변경 행동의 고정 키: 작업·단계와 행동의 의미(종류·대상·값)의 해시. 순번과 무관해 같은 행동은 몇 번째로 오든 한 번만,
      // 다른 행동은 같은 순번이라도 실행된다. 이동·확인 같은 바꾸지 않는 행동은 새 세션에서 다시 해야 하므로 키를 붙이지 않는다.
      const actionKey = MUTATING.includes(action.type) ? actionKeyOf(scope.jobId, stepIndex, action) : undefined;
      const out: ActionOutcome = session ? await session.perform(action, secrets, actionKey) : await rt.obs.perform(scope, action, actionKey);
      // 외부 행동이 끝나는 사이 자리를 잃었거나 실행 시간 상한을 넘었으면 결과를 쓰지 않고 멈춘다(작업자가 상황에 맞게 정리)
      guard();
      if (out.kind === "needs_customer") return { kind: "needs_customer", action: out.action };
      if (out.kind === "retryable") return { kind: "retry", reason: out.reason };
      if (out.kind === "fatal") return { kind: "failed", reason: out.reason };
      // 실행기가 알려 준 PC가 이 작업이 바꾼 PC와 다르면 그 결과(증거·PC)를 저장하지 않고 멈춘다
      if (!session && obsPairing && out.facts?.obsPairingId && out.facts.obsPairingId !== obsPairing) return { kind: "failed", reason: "obs_target_changed" };
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
