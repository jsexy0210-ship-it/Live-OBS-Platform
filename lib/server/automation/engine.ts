import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { cueMatches, matchException, navRulesFor, plannerPathSegments, plannerVocabulary, resolveShop, type DoneCheck, type Playbook } from "./playbook";
import {
  sanitizeObservation,
  pageAllowedByNav,
  secretOriginAllowed,
  validateDecision,
  type ActionOutcome,
  type AutomationAction,
  type AutomationRuntime,
  type BrowserSession,
  type ConnectionFacts,
  type ExpectedPage,
  type JobScope,
  type NavRules,
  type PlannerDecision,
  type VerificationEvidence,
} from "./ports";
import { DB_INT_MAX, externalId, fromExecutor } from "./boundary";
import { AUTOMATION_LIMITS } from "./config";
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
  // 변경 행동(클릭·입력·OBS 설정·테스트 주문)을 이번 실행에서 처음 하기 직전(변경 뒤 실패면 정리 필요로 보기 위해)
  markChanged?(stepKey: string): Promise<ChangeMark>;
  // 실행기가 「적용 안 함」(행동 0회)을 보장하는 결과로 거절했다: 바로 앞 markChanged가 새로 남긴 기록만 되돌린다
  unmarkChanged?(stepKey: string, mark: ChangeMark): Promise<void>;
  // 외부 행동 격리 창(trackedWindow): 행동 직전 시작 기록(점유를 잃었으면 던져 행동하지 않음, 기록한 시작 시각을 돌려줌)과
  // 행동이 돌아온 뒤 종료 확인, 상한을 넘긴 호출이 늦게라도 끝났다는 확인(settle). 종료 확인은 자기 시작 기록에만 묶는다
  actionStarted?(): Promise<Date | void>;
  actionEnded?(startedAt?: Date): Promise<void>;
  actionTimedOut?(): void;
  actionSettled?(startedAt: Date): Promise<void>;
  // 자리를 잃었어도 해야 하는 정리 연산(브라우저 세션 닫기·보관)의 시작 기록: 점유 확인 없이 남긴다(기록은 다음 소유자를 늦추는 보수적인 쪽)
  releaseStarted?(): Promise<Date | void>;
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

// 행동 종류별 효과 범위(분류는 이곳 한 곳에서만 한다)
// - external: 세션이 닫혀도 남는 외부 효과(고객 PC의 OBS 설정, 테스트 주문 이벤트). 고정 키(멱등 키)로 한 번만 적용한다.
// - session: 브라우저 세션 안의 조작(누르기·입력). 재시도는 새 세션이라 입력값·화면 상태가 없으므로 고정 키로 건너뛰지 않고 다시 한다.
//   쇼핑몰 쪽에 남는 결과(앱 설치·저장)는 단계 완료 기록(진행 위치)으로 한 번만 넘어가고, 같은 값으로 다시 저장해도 결과가 같다.
// - none: 바꾸지 않는 행동(이동·확인·고객 요청·단계 끝)
export const ACTION_EFFECT: Record<AutomationAction["type"], "external" | "session" | "none"> = {
  navigate: "none",
  click: "session",
  fill: "session",
  request_customer: "none",
  obs_add_overlay_source: "external",
  obs_remove_overlay_source: "external",
  obs_apply_display_settings: "external",
  send_test_event: "external",
  check_overlay_shows_test_event: "none",
  step_done: "none",
};

// 바꾸는 행동(외부·세션 모두). 무료 재연결의 쇼핑몰·PC 대조는 이 행동을 처음 하기 바로 전에 한다(이동·고객 로그인 대기·관찰·확인은 대조 전에 허용).
// 실행기 계약상 행동을 0회 하고 거절한 결과(확인과 실행 사이 문서·PC가 바뀜, ports.ts). 이 결과면 그 행동으로 바뀐 것이 없다.
const NOT_APPLIED: ReadonlySet<string> = new Set(["page_mismatch", "pairing_mismatch"]);
// 변경 기록(markChanged)이 이번에 새로 남긴 것: 단계 추가 여부와 새로 남긴 첫 변경 시각(이미 있었으면 null)
export type ChangeMark = { stepAdded: boolean; changedAt: Date | null };
// 포트 호출 계약: 실행기·로컬 도구·판단 모델·비밀값·연습 환경의 모든 메서드는 callPort로만 부른다(시험용 가짜는 밖에서 부르면 거부한다).
// 결과는 판별 유니온이라 부른 쪽이 상한 초과(timeout)·오류(error)를 반드시 다뤄야 타입이 통과한다(undefined로 새지 않음).
// - 상한(T_action)에 이르면 기다리지 않고 timeout을 돌려주며, 넘겨 준 중단 신호를 보낸다(계약: 받은 쪽은 스스로 멈춘다).
// - window: 외부 상태를 바꾸는 호출의 격리 창 기록(시작 기록 → 종료 확인). 상한을 넘기면 중단 신호를 보내고 종료 확인을 남기지 않는다.
//   격리 창은 중단한 호출이 실제로 끝났다는 확인(settle: 늦은 결과 정리까지 마친 뒤 actionSettled) 또는 강제 상한(시작 + 상한 + 여유) 중
//   먼저 오는 것까지 이어진다. 그 전에는 작업을 다른 작업자에게 넘기지 않는다(queue.ts quiescent).
// - onLate: 상한을 넘긴 뒤 늦게 성공한 결과(세션 같은 자원)를 정리한다. 부른 쪽은 이미 떠났으므로 반드시 여기서 닫는다.
export type PortResult<T> = { ok: true; value: T } | { ok: false; reason: "timeout" } | { ok: false; reason: "error"; error: unknown };
export type ActionWindowHooks = {
  actionStarted?(): Promise<Date | void>;
  // 돌아온 호출의 종료 확인. 자기 시작 기록(startedAt)에만 묶는다
  actionEnded?(startedAt?: Date): Promise<void>;
  // 상한을 넘겨 아직 끝나지 않은 호출이 생겼다(끝났다는 확인 전까지 같은 창의 종료 확인을 남기지 않는다)
  actionTimedOut?(): void;
  actionSettled?(startedAt: Date): Promise<void>;
};

// 한 작업(또는 연습 회차)의 격리 창 기록. 창은 행 하나의 시작·종료 기록이라, 종료 확인은 자기 시작 기록이 그대로일 때만 남기고
// (store.end가 시작 시각 조건으로 쓴다), 상한을 넘겨 아직 끝나지 않은 호출이 하나라도 있으면 뒤 호출(세션 닫기 등)이 돌아와도
// 종료 확인을 남기지 않는다. 뒤 호출의 시작 기록은 시각을 앞으로만 옮기므로(창을 늘림) 앞 호출의 강제 상한보다 일찍 풀리지 않는다.
// 프로세스가 죽으면 기록이 남지 않아 강제 상한(시작 + 상한 + 여유)으로만 풀린다(보수적인 쪽).
// 자리를 잃은 뒤의 정리 호출(release의 owned=false)은 종료 확인을 남기지 않는다: 이 프로세스는 그 사이 새 소유자(다른 프로세스)가 시작한
// 행동의 진행 여부를 알 수 없으므로 창은 강제 상한으로만 풀린다.
export function trackedWindow(store: { start(): Promise<Date>; release(): Promise<{ at: Date; owned: boolean }>; end(startedAt: Date): Promise<void> }) {
  let unsettled = 0;
  const noEnd = new Set<number>();
  const endIfAllowed = async (startedAt: Date) => {
    if (!noEnd.has(startedAt.getTime())) await store.end(startedAt);
  };
  return {
    actionStarted: () => store.start(),
    releaseStarted: async () => {
      const r = await store.release();
      if (!r.owned) noEnd.add(r.at.getTime());
      return r.at;
    },
    actionEnded: async (startedAt?: Date) => {
      if (unsettled === 0 && startedAt) await endIfAllowed(startedAt);
    },
    actionTimedOut: () => void unsettled++,
    actionSettled: async (startedAt: Date) => {
      unsettled--;
      if (unsettled === 0) await endIfAllowed(startedAt);
    },
  };
}
const PORT_SCOPE = new AsyncLocalStorage<true>();
export const insidePortCall = () => PORT_SCOPE.getStore() === true;
export async function callPort<T>(run: (signal: AbortSignal) => Promise<T>, opts: { window?: ActionWindowHooks; onLate?: (late: T) => unknown } = {}): Promise<PortResult<T>> {
  const startedAt = await opts.window?.actionStarted?.();
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const call = PORT_SCOPE.run(true, async () => run(abort.signal));
  try {
    return await Promise.race([
      call.then(
        (value): PortResult<T> => ({ ok: true, value }),
        (error): PortResult<T> => ({ ok: false, reason: "error", error }),
      ),
      new Promise<PortResult<T>>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          opts.window?.actionTimedOut?.();
          abort.abort();
          resolve({ ok: false, reason: "timeout" });
        }, AUTOMATION_LIMITS.actionTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (!timedOut) await opts.window?.actionEnded?.(startedAt || undefined);
    else {
      // 늦은 결과를 정리한 뒤에야 끝났다고 확인한다(정리 중에 다른 작업자가 이어받지 않게)
      const { onLate, window } = opts;
      void call
        .then(
          async (late) => {
            if (onLate) await PORT_SCOPE.run(true, async () => onLate(late));
          },
          () => undefined,
        )
        .then(async () => {
          if (startedAt && window?.actionSettled) await window.actionSettled(startedAt);
        })
        .catch(() => undefined);
    }
  }
}

// 읽기 포트 호출(관찰·현재 주소·쇼핑몰·PC 읽기·비밀값 읽기·세션 열기): 상한 초과는 ExternalReadTimeout으로 올려
// 작업자가 이 작업을 다시 시도로 돌리고 다음 일을 한다. 오류는 그대로 올린다.
export class ExternalReadTimeout extends Error {
  constructor() {
    super("read_timeout");
  }
}
export function valueOrThrow<T>(r: PortResult<T>): T {
  if (r.ok) return r.value;
  if (r.reason === "timeout") throw new ExternalReadTimeout();
  throw r.error;
}
const readPort = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => valueOrThrow(await callPort(run));
// 바꾸는 행동의 결과: 상한 초과는 일시 실패로 본다(다시 시도). 오류는 그대로 올린다.
const ACTION_TIMEOUT: ActionOutcome = { kind: "retryable", reason: "timeout" };
function actionOutcome(r: PortResult<ActionOutcome>): ActionOutcome {
  if (r.ok) return r.value;
  if (r.reason === "timeout") return ACTION_TIMEOUT;
  throw r.error;
}
// 세션 열기: 보관본을 복원(하고 지우는) 외부 상태 변경이라 격리 창 기록 안에서 한다. 상한을 넘긴 뒤 늦게 열린 세션은
// 아무도 쓰지 않으므로 보관하지 않고 바로 닫는다(늦게 열린 세션이 남아 자원을 쥐거나 상태를 쓰지 않게).
async function openSession(rt: AutomationRuntime, scope: JobScope, window: ActionWindowHooks): Promise<BrowserSession> {
  return valueOrThrow(await callPort((signal) => rt.browser.open(scope, signal), { window, onLate: (late) => callPort((signal) => late.close({ signal })) }));
}
// 세션 닫기(보관 포함)도 격리 창 기록 안에서 한다. 자리를 잃었어도 닫아야 하므로 시작 기록은 점유 확인 없이(releaseStarted) 남긴다.
const closeWindow = (hooks: { releaseStarted?(): Promise<Date | void> } & ActionWindowHooks): ActionWindowHooks => ({
  actionStarted: hooks.releaseStarted ?? hooks.actionStarted,
  actionEnded: hooks.actionEnded,
  actionTimedOut: hooks.actionTimedOut,
  actionSettled: hooks.actionSettled,
});

// 완료·되돌림 판정 공용 장치(본 단계·검증 단계·되돌리기 모두): 행동 전 대조와 같은 기준을 통과한 관찰에만 글 단서를 적용한다.
// 브라우저는 관찰 주소 = 지금 문서 주소이고 이동 규칙 안이며 판정의 기대 경로로 시작해야 하고, OBS는 지금 PC가 이 작업이 확인한 PC여야 한다.
async function verifiedOnExpected(
  kind: "browser" | "obs",
  session: BrowserSession | null,
  rt: AutomationRuntime,
  scope: JobScope,
  check: DoneCheck,
  nav: NavRules | null,
  pairing: string | null | undefined,
): Promise<boolean> {
  if (kind === "browser") {
    if (!session || !check.pagePath || !nav) return false;
    const after = await readPort((signal) => session.observe(signal));
    const here = await readPort((signal) => session.currentUrl(signal));
    if (!after.url || !here || here !== after.url || !pageAllowedByNav(after.url, nav)) return false;
    let path: string;
    try {
      path = new URL(after.url).pathname;
    } catch {
      return false;
    }
    return path.startsWith(check.pagePath) && cueMatches({ textIncludes: check.textIncludes }, after);
  }
  const now = externalId(await readPort((signal) => rt.obs.currentPairingId(scope, signal)));
  if (!pairing || !now.ok || now.value !== pairing) return false;
  return cueMatches({ textIncludes: check.textIncludes }, await readPort((signal) => rt.obs.observe(scope, signal)));
}

const MUTATING: readonly AutomationAction["type"][] = (Object.keys(ACTION_EFFECT) as AutomationAction["type"][]).filter((t) => ACTION_EFFECT[t] !== "none");
// 고정 키를 붙이는 행동: 세션 밖에 남는 효과만
const keyed = (a: AutomationAction) => ACTION_EFFECT[a.type] === "external";

export type EngineOptions = {
  // 실행 자리를 잃으면 abort된다. 외부 호출(관찰·판단·실행) 직전마다 확인한다.
  signal?: AbortSignal;
  // 고객 행동 대기로 멈출 때 브라우저 상태를 보관할지(기본 true). 연습 실행은 보관하지 않는다.
  keepBrowserStateOnWait?: boolean;
  // 이전 실행에서 무료 재연결 대조를 통과했다(작업 행 기록). 브라우저 단계부터 다시 하지 않으면 다시 대조하지 않는다.
  targetVerified?: boolean;
  // 허용 규칙(비밀값 칸·누를 대상·이동 경로·판단 모델 어휘)을 정하는 작업서. 정해진 행동 없이 판단 모델로만 돌릴 때 규칙만 따로 줄 수 있다. 없으면 playbook.
  // 작업자는 구매 때 검증된 버전만 넘긴다(버전이 바뀐 작업은 실행하지 않음, worker.ts)
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
  // 재연결·재설치: 실제 연결된 쇼핑몰·PC가 이 값과 같아야 한다
  expectFacts?: { shopKey: string | null; obsPairingId: string | null } | null;
  // 대상을 아직 알 수 없을 때(로그인 전·로컬 도구 미연결): true면 고객 행동 대기(유료 재설치), 아니면 실패(무료 재연결)
  waitForUnknownTarget?: boolean;
};

export async function runSteps(rt: AutomationRuntime, scope: JobScope, opts: EngineOptions, hooks: EngineHooks): Promise<EngineResult> {
  let session: BrowserSession | null = null;
  let result: EngineResult | null = null;
  const guard = () => {
    if (opts.signal?.aborted) throw new EngineAborted();
  };
  let held = false;
  const close = async () => {
    const s = session as BrowserSession | null;
    return s ? callPort((signal) => s.close({ keepForResume: held, signal }), { window: closeWindow(hooks) }) : null;
  };
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
  } catch (e) {
    await close();
    throw e;
  }
  // 고객 행동 대기면 이 작업의 로그인·승인 상태를 암호화 보관해 재개 때 이어 간다. 그 밖에는 모두 지운다.
  // 닫기·보관도 외부 상태 변경이라 격리 창 기록 안에서 한다(상한을 넘기면 중단 신호로 보관하지 않음).
  const closed = await close();
  if (closed && !closed.ok) {
    // 보관이 끝나지 않았다(상한 초과·오류): 보관본이 있다고 보고 고객 대기로 두지 않고 다시 시도한다
    // (보관본 없는 고객 대기는 재개 뒤 같은 로그인·승인을 다시 요구하게 된다)
    if (held) return { kind: "retry", reason: closed.reason === "timeout" ? "state_save_timeout" : "state_save_failed" };
    if (closed.reason === "error") throw closed.error;
  }
  return result;
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
      s = await openSession(rt, scope, hooks);
      setSession(s);
    }
    return s;
  };
  let verifying = opts.verifying;
  let evidence: VerificationEvidence | undefined;
  const secrets = await readPort((signal) => rt.vault.forJob(scope, signal));
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
      const shop = externalId(await readPort((signal) => session.currentShopKey(signal)));
      if (!shop.ok) return { kind: "failed", reason: "shop_identity_invalid" };
      shopKey = shop.value;
    }
    guard();
    const pc = externalId(await readPort((signal) => rt.obs.currentPairingId(scope, signal)));
    if (!pc.ok) return { kind: "failed", reason: "pc_identity_invalid" };
    const obsPairingId = pc.value;
    if (opts.waitForUnknownTarget && !shopKey) return { kind: "needs_customer", action: "LOGIN" };
    if (opts.waitForUnknownTarget && !obsPairingId) return { kind: "needs_customer", action: "LOCAL_TOOL" };
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
  const markedSteps = new Set<string>();
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
      const raw = session ? await readPort((signal) => session.observe(signal)) : await readPort((signal) => rt.obs.observe(scope, signal));
      const exception = pb ? matchException(pb, raw) : null;
      if (exception) {
        await touchStats();
        if ("customerAction" in exception) return { kind: "needs_customer", action: exception.customerAction };
        if ("retry" in exception) return { kind: "retry", reason: exception.retry };
        return { kind: "failed", reason: exception.fail };
      }
      let action: AutomationAction | null = null;
      let costWon = 0;
      // 이번에 꺼낸 작업서 행동(문서가 바뀌어 실행하지 않으면 되돌려 놓는다)
      let fromScript: (typeof scripted)[number] | null = null;
      if (!deviated && scripted.length > 0) {
        if (cueMatches(scripted[0].expect, raw)) {
          fromScript = scripted.shift()!;
          action = resolveShop(fromScript.action, opts.shopHost);
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
        // 화면 이탈은 판단 모델을 부르기 전에 기록한다(호출이 계속 실패해 작업이 닫혀도 작업서가 재검증 대상이 되게)
        if (stats.deviatedNow) await touchStats();
        const vocabulary = plannerVocabulary(pb ?? secretBook?.steps[step.key]);
        // 판단 호출도 격리 창 장치 안에서 한다: 상한을 넘기면 중단 신호를 보내고 이 작업을 실패로 끝내 작업자가 한 호출에 묶이지 않게 한다
        const observation = sanitizeObservation(raw, secrets, vocabulary, { shopHost: opts.shopHost, pathSegments: plannerPathSegments(secretBook) });
        const decided = await callPort((signal) => rt.planner.decide({ step, observation, history, reference }, signal), { window: hooks });
        if (!decided.ok) {
          if (decided.reason === "timeout") return { kind: "failed", reason: "planner_timeout" };
          throw decided.error;
        }
        const decision = decided.value;
        stats.plannerCalls++;
        // 모델이 낸 비용 원값부터 검사한다(음수·소수·숫자 아님은 바꿔 넘기지 않고 bad_cost로 멈춤). 통과한 비용만 누적한다
        const check = validateDecision(step, decision, secrets, secretTargets, allowedTargets, nav);
        if (!check.ok && check.reason === "bad_cost") {
          await touchStats();
          return { kind: "failed", reason: "unsafe_action:bad_cost" };
        }
        costWon = decision.costWon;
        // 남은 한도를 넘는 비용(DB 정수 범위 밖 포함)은 합계를 DB 최대값 안으로만 기록하고 바로 cost_limit으로 끝낸다(쓰기 실패로 재시도·재호출 반복 금지)
        const overLimit = costWon > opts.costLimit - stats.costUsed;
        stats.costUsed = Math.min(stats.costUsed + costWon, DB_INT_MAX);
        await touchStats();
        if (overLimit) return { kind: "failed", reason: "cost_limit" };
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
      let confirmedPairing: string | undefined;
      if (!session) {
        guard();
        const read = externalId(await readPort((signal) => rt.obs.currentPairingId(scope, signal)));
        // 형식에 맞지 않는 PC 식별자(200자 초과 등)는 자르지 않고 바꾸기 전에 멈춘다
        if (!read.ok) return { kind: "failed", reason: "pc_identity_invalid" };
        const pairingId = read.value;
        if (!pairingId) return want && !opts.waitForUnknownTarget ? { kind: "failed", reason: "reconnect_target_unverified" } : { kind: "needs_customer", action: "LOCAL_TOOL" };
        if (want && pairingId !== want.obsPairingId) return { kind: "failed", reason: "reconnect_target_mismatch" };
        if (obsPairing && pairingId !== obsPairing) return { kind: "failed", reason: "obs_target_changed" };
        if (mutating) {
          if (!obsTargetClaimed && hooks.claimObsTarget) {
            await hooks.claimObsTarget(pairingId);
            obsTargetClaimed = true;
          }
          obsPairing = pairingId;
        }
        confirmedPairing = pairingId;
      }
      // 비밀값 입력은 승인 때 관찰한 주소와 실행 직전 실제 문서 주소가 모두 작업 대상 쇼핑몰의 관리자 경로여야 하고,
      // 관찰한 화면에 관리자 로그인 상태 단서가 있어야 한다(리다이렉트로 다른 출처·같은 호스트의 쇼핑몰 앞 화면에 간 경우 차단)
      if (action.type === "fill" && "secretRef" in action.value) {
        guard();
        const here = session ? await readPort((signal) => session.currentUrl(signal)) : null;
        const origin = secretBook?.secretOrigin;
        const ok = (u: string | null) => !!u && !!origin && secretOriginAllowed(u, opts.shopHost, origin.pathPrefixes);
        if (!origin || !ok(raw.url) || !ok(here) || !cueMatches(origin.adminCue, raw)) return { kind: "failed", reason: "unsafe_action:secret_origin_not_allowed" };
      }
      // 브라우저의 모든 변경 행동(누르기·입력)은 관찰한 주소와 실행 직전 실제 문서 주소가 모두 이 작업의 쇼핑몰 호스트(정확히 일치)와
      // 단계 허용 경로 안이어야 한다(같은 플랫폼의 다른 쇼핑몰·같은 호스트의 쇼핑몰 앞 화면으로 넘어간 경우 행동 0건)
      // 확인한 주소·규칙은 실행기에도 넘겨 행동 직전에 다시 대조하게 한다(확인과 실행 사이 리다이렉트 차단, 다르면 page_mismatch)
      let expectedPage: ExpectedPage | undefined;
      if (session && mutating) {
        guard();
        const here = await readPort((signal) => session.currentUrl(signal));
        if (!nav || !here || !pageAllowedByNav(raw.url, nav) || !pageAllowedByNav(here, nav)) return { kind: "failed", reason: "unsafe_action:page_not_allowed" };
        // 관찰한 문서와 지금 문서가 다르면(관찰과 확인 사이 이동) 판단 근거가 지금 화면이 아니다: 행동 0건으로 다시 관찰한다
        if (here !== raw.url) {
          if (fromScript) {
            scripted.unshift(fromScript);
            stats.playbookActions--;
          }
          history.pop();
          continue;
        }
        const secretFill = action.type === "fill" && "secretRef" in action.value;
        expectedPage = { url: raw.url, nav, ...(secretFill ? { secretOrigin: { shopHost: opts.shopHost, pathPrefixes: secretBook?.secretOrigin.pathPrefixes ?? [], adminCueText: secretBook?.secretOrigin.adminCue.textIncludes ?? [] } } : {}) };
      }
      // 이번 행동 직전에 새로 남긴 변경 기록(실행기가 행동 0회로 거절하면 이것만 되돌린다)
      let freshMark: ChangeMark | null = null;
      // 실행기를 불렀는가. 변경 기록 뒤 실행기를 부르기 전에 끝나는 모든 경로(자리 잃음·취소·heartbeat 오류·guard 예외)에서
      // 이번 기록을 되돌린다(바꾼 것이 없음). 결과 분기에 기대지 않고 finally로 한다.
      let performStarted = false;
      let out!: ActionOutcome;
      try {
        if (MUTATING.includes(action.type) && !markedSteps.has(step.key) && hooks.markChanged) {
          freshMark = await hooks.markChanged(step.key);
          markedSteps.add(step.key);
        }
        guard();
        // 고정 키: 작업·단계와 행동의 의미(종류·대상·값)의 해시. 순번과 무관해 같은 행동은 몇 번째로 오든 한 번만,
        // 다른 행동은 같은 순번이라도 실행된다. 세션 밖에 남는 효과(ACTION_EFFECT external)에만 붙이고, 세션 안의 조작(누르기·입력)과
        // 바꾸지 않는 행동은 새 세션에서 다시 해야 하므로 붙이지 않는다.
        const actionKey = keyed(action) ? actionKeyOf(scope.jobId, stepIndex, action) : undefined;
        // OBS 쪽은 확인한 PC를 넘겨 로컬 도구가 실행 직전에 비교하게 하고(다르면 행동 0건으로 거절), 결과의 실제 실행 PC를 다시 대조한다
        // 결과는 경계(fromExecutor)에서 정규화한 값만 쓴다(사유는 정해 둔 코드로, 식별자는 형식 검사, 증거는 비밀값 가림)
        out = fromExecutor(
          actionOutcome(
            await callPort(
              (signal) => {
                performStarted = true;
                return session ? session.perform(action, secrets, actionKey, expectedPage, signal) : rt.obs.perform(scope, action, actionKey, confirmedPairing, signal);
              },
              { window: hooks },
            ),
          ),
          secrets,
        );
      } finally {
        if (!performStarted && freshMark && hooks.unmarkChanged) {
          await hooks.unmarkChanged(step.key, freshMark);
          markedSteps.delete(step.key);
        }
      }
      // 행동 0회가 보장된 거절이면 바꾼 것이 없으므로 이번에 남긴 변경 기록을 되돌린다. 자리를 잃었어도(취소·회수와 겹침) 먼저 한다(guard 전)
      if (out.kind === "fatal" && NOT_APPLIED.has(out.reason) && freshMark && hooks.unmarkChanged) {
        await hooks.unmarkChanged(step.key, freshMark);
        markedSteps.delete(step.key);
      }
      if (!session && out.kind === "ok" && out.pairingId !== confirmedPairing) return { kind: "failed", reason: "obs_target_changed" };
      // 외부 행동이 끝나는 사이 자리를 잃었거나 실행 시간 상한을 넘었으면 결과를 쓰지 않고 멈춘다(작업자가 상황에 맞게 정리)
      guard();
      if (out.kind === "needs_customer") return { kind: "needs_customer", action: out.action };
      if (out.kind === "retryable") return { kind: "retry", reason: out.reason };
      if (out.kind === "fatal") return { kind: "failed", reason: out.reason };
      // 실행기가 알려 준 PC가 이 작업이 바꾼 PC와 다르면 그 결과(증거·PC)를 저장하지 않고 멈춘다
      if (!session && obsPairing && out.facts?.obsPairingId && out.facts.obsPairingId !== obsPairing) return { kind: "failed", reason: "obs_target_changed" };
      Object.assign(facts, out.facts);
      // OBS 쪽 성공 결과에는 실제로 실행한 PC가 반드시 담긴다(계약). 바꾸지 않고 확인만 한 경우도 그 PC를 연결 결과로 남긴다
      // (이미 설정된 OBS를 확인만 하고 끝난 작업도 같은 PC 재연결 판정이 되도록)
      if (!session && out.pairingId && !facts.obsPairingId) facts.obsPairingId = out.pairingId;
      if (out.verified) {
        verified = true;
        evidence = out.evidence ?? { verified: true };
      }
      // 검증 단계는 테스트 표시를 실제로 확인한 뒤에만 끝낸다(모델·작업서가 끝났다고 해도 넘어가지 않는다)
      // 단계 끝 신호만으로 끝내지 않는다: 다시 관찰한 화면·상태에 그 단계의 완료 판정(doneWhen)을 적용해 맞을 때만 끝낸다.
      // 판정이 없으면(작업서 없음) 끝낼 수 없다. 맞지 않으면 작업서대로 되지 않은 것이라 화면 이탈로 보고 판단 모델로 넘긴다.
      if (out.stepDone && (step.kind !== "verify" || verified)) {
        const doneWhen = (opts.playbook ?? secretBook)?.steps[step.key]?.doneWhen;
        if (!doneWhen) return { kind: "failed", reason: "step_unverifiable" };
        guard();
        if (await verifiedOnExpected(session ? "browser" : "obs", session, rt, scope, doneWhen, nav, confirmedPairing)) done = true;
        else if (!deviated) {
          deviated = true;
          if (!stats.deviatedSteps.includes(step.key)) stats.deviatedSteps.push(step.key);
          stats.deviatedNow = true;
        }
      }
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

// ───── 되돌리기 ─────
// 실패로 끝나는 작업이 이미 바꾼 것(쇼핑몰 앱·웹훅, OBS 소스)을 구매 때 버전 작업서의 되돌리기 단계로만 되돌린다.
// 화면 단서가 맞지 않거나(판단 모델이 필요), 검사에 걸리거나, 실행 결과가 성공이 아니거나, PC가 이 작업이 바꾼 PC가 아니면
// 판단 모델을 부르지 않고 바로 「정리 필요」로 사람에게 넘긴다.
export type RollbackResult = { kind: "rolled_back" } | { kind: "cleanup_needed"; reason: string };

export async function runRollback(
  rt: AutomationRuntime,
  scope: JobScope,
  opts: { playbook: Playbook; shopHost: string | null; stepIndex: number; mutatedSteps: readonly string[]; obsPairingId: string | null; signal?: AbortSignal },
  hooks: { touch(): Promise<void>; releaseStarted?(): Promise<Date | void> } & ActionWindowHooks,
): Promise<RollbackResult> {
  const guard = () => {
    if (opts.signal?.aborted) throw new EngineAborted();
  };
  const secrets = await readPort((signal) => rt.vault.forJob(scope, signal));
  let session: BrowserSession | null = null;
  // 바꾼 단계(mutatedSteps)마다 되돌리기 항목(행동 1개 이상)이 있어야 한다. 하나라도 없으면(사람 정리 단계·모르는 단계) 아무것도 하지 않고
  // 「정리 필요」로 넘긴다(되돌리지 못한 변경을 남긴 채 되돌렸다고 하지 않음, fail-closed)
  for (const step of opts.mutatedSteps) {
    if (!opts.playbook.rollback.some((rb) => rb.forStep === step && rb.actions.length > 0)) return { kind: "cleanup_needed", reason: `rollback_not_covered:${step}` };
  }
  try {
    for (const rb of opts.playbook.rollback) {
      const at = STEPS.findIndex((s) => s.key === rb.forStep);
      // 변경 기록(mutatedSteps)이 있는 단계만 되돌린다(완료 여부·진행 위치와 무관). 기존 설정을 확인만 하고 끝낸 단계·아직 바꾸지 않은 단계는
      // 판매자의 기존 앱·웹훅일 수 있어 건드리지 않는다
      if (at < 0 || !opts.mutatedSteps.includes(rb.forStep)) continue;
      const step = { key: `rollback:${rb.forStep}`, kind: rb.kind } as const;
      const nav = { shopHost: opts.shopHost, pathPrefixes: rb.allowedUrls.pathPrefixes, queryKeys: rb.allowedUrls.queryKeys };
      // 이 되돌리기 단계에서 OBS를 바꾼 PC(되돌림 확인도 같은 PC에서만)
      let lastPairing: string | undefined;
      for (let i = 0; i < rb.actions.length; i++) {
        guard();
        if (rb.kind === "browser" && !session) session = await openSession(rt, scope, hooks);
        const live = session;
        const raw = live && rb.kind === "browser" ? await readPort((signal) => live.observe(signal)) : await readPort((signal) => rt.obs.observe(scope, signal));
        if (!cueMatches(rb.actions[i].expect, raw)) return { kind: "cleanup_needed", reason: `rollback_deviated:${rb.forStep}` };
        const action = resolveShop(rb.actions[i].action, opts.shopHost);
        const check = validateDecision(step, { action, costWon: 0 }, secrets, {}, rb.allowedTargets, nav);
        if (!check.ok) return { kind: "cleanup_needed", reason: `rollback_unsafe:${check.reason}` };
        let expectedPage: ExpectedPage | undefined;
        if (live && rb.kind === "browser" && MUTATING.includes(action.type)) {
          guard();
          const here = await readPort((signal) => live.currentUrl(signal));
          if (!here || !pageAllowedByNav(raw.url, nav) || !pageAllowedByNav(here, nav)) return { kind: "cleanup_needed", reason: "rollback_unsafe:page_not_allowed" };
          // 관찰한 문서와 지금 문서가 다르면 되돌리기를 이어 가지 않는다(판단 모델 없이는 다시 맞출 수 없음)
          if (here !== raw.url) return { kind: "cleanup_needed", reason: "rollback_unsafe:page_changed" };
          expectedPage = { url: raw.url, nav };
        }
        let pairing: string | undefined;
        if (rb.kind === "obs") {
          guard();
          const read = externalId(await readPort((signal) => rt.obs.currentPairingId(scope, signal)));
          const current = read.ok ? read.value : null;
          if (!current || (opts.obsPairingId && current !== opts.obsPairingId)) return { kind: "cleanup_needed", reason: "rollback_obs_target" };
          pairing = current;
          lastPairing = current;
        }
        await hooks.touch();
        guard();
        const actionKey = keyed(action) ? actionKeyOf(scope.jobId, 100 + at, action) : undefined;
        const out = fromExecutor(
          actionOutcome(await callPort((signal) => (rb.kind === "browser" ? session!.perform(action, secrets, actionKey, expectedPage, signal) : rt.obs.perform(scope, action, actionKey, pairing, signal)), { window: hooks })),
          secrets,
        );
        guard();
        if (out.kind !== "ok" || (rb.kind === "obs" && out.pairingId !== pairing)) return { kind: "cleanup_needed", reason: `rollback_failed:${rb.forStep}` };
      }
      // 실행 결과 신호만으로 되돌렸다고 보지 않는다: 다시 관찰한 상태가 되돌림 확인(doneWhen)과 맞아야 한다
      if (rb.actions.length > 0) {
        guard();
        if (!(await verifiedOnExpected(rb.kind, session, rt, scope, rb.doneWhen, nav, lastPairing))) return { kind: "cleanup_needed", reason: `rollback_unverified:${rb.forStep}` };
      }
    }
    return { kind: "rolled_back" };
  } finally {
    // 되돌리기 세션 닫기도 격리 창 기록 안에서 한다(자리를 잃었어도 닫으므로 시작 기록은 점유 확인 없이). 보관하지 않으므로 상한 초과는 기다리지 않는다
    const s = session as BrowserSession | null;
    if (s) {
      const closed = await callPort((signal) => s.close({ signal }), { window: closeWindow(hooks) });
      if (!closed.ok && closed.reason === "error") throw closed.error;
    }
  }
}
