import type { AutomationCustomerAction } from "@prisma/client";
import type { Step, StepKind } from "./steps";

// 세 구성요소의 경계(docs/AUTOMATION.md 3절).
// - AutomationPlanner(Gemini 판단): 화면 관찰 → 다음 행동 1개. 아무것도 실행하지 않는다.
// - BrowserExecutor(서버 브라우저 실행기): 작업마다 격리된 세션에서 허용된 행동만 실행한다.
// - ObsBridge(고객 PC 로컬 연결 도구 + OBS WebSocket): OBS 쪽 행동과 테스트 표시 확인.
// 1차는 모두 가짜 구현(fakes.ts)만 있다. 실제 Gemini·브라우저·로컬 도구 연결은 비용 산정·승인 뒤에 붙인다.

export type JobScope = { readonly sellerId: string; readonly jobId: string };

// 모델이 값을 보지 못하는 비밀값. 실행기가 실행 직전에만 실제 값으로 바꾼다.
export type SecretRef = "webhook_url" | "webhook_secret";
export type JobSecrets = Readonly<Record<SecretRef, string>>;

export type AutomationAction =
  | { type: "navigate"; url: string }
  | { type: "click"; target: string }
  | { type: "fill"; target: string; value: { secretRef: SecretRef } | { text: string } }
  | { type: "request_customer"; action: AutomationCustomerAction }
  | { type: "obs_add_overlay_source" }
  | { type: "obs_apply_display_settings" }
  | { type: "send_test_event" }
  | { type: "check_overlay_shows_test_event" }
  // 판단 모델의 「이 단계 끝」 요청. 끝났는지는 실행기·로컬 도구가 실제 상태로 확인한다.
  | { type: "step_done" };

export type Observation = { url: string | null; text: string };
// 모델에 넘기는 관찰. 비밀값을 지우고, 화면 글은 신뢰하지 않는 데이터로만 넘긴다.
export type SafeObservation = { url: string | null; untrustedPageText: string };

// reference: 연결 작업서의 단계 설명·성공 사례(확정 ⑦-1). 작업서가 없거나 화면이 작업서와 다를 때 판단 모델이 참고한다.
export type PlannerReference = { guide: string; examples: readonly string[]; referenceImages: readonly string[] };
export type PlannerInput = { step: Step; observation: SafeObservation; history: readonly string[]; reference: PlannerReference | null };
// costWon: 이 판단 호출에 든 비용(원 추정). 작업당 비용 상한 계산에 쓴다.
export type PlannerDecision = { action: AutomationAction; costWon: number };

export interface AutomationPlanner {
  // 쓰는 모델 이름(config.ts plannerConfig). 비용 산정·기록용
  readonly model: string;
  decide(input: PlannerInput): Promise<PlannerDecision>;
}

// 연결 결과로 알게 된 값(무료 재연결 판정용)과 검증 증거. 비밀값을 넣지 않는다.
export type ConnectionFacts = { shopKey?: string; obsPairingId?: string };
export type VerificationEvidence = Readonly<Record<string, string | number | boolean>>;

export type ActionOutcome =
  | { kind: "ok"; stepDone: boolean; verified?: boolean; facts?: ConnectionFacts; evidence?: VerificationEvidence }
  | { kind: "needs_customer"; action: AutomationCustomerAction }
  | { kind: "retryable"; reason: string }
  | { kind: "fatal"; reason: string };

export interface BrowserSession {
  readonly id: string;
  observe(): Promise<Observation>;
  perform(action: AutomationAction, secrets: JobSecrets): Promise<ActionOutcome>;
  // 지금 로그인된 관리 화면의 쇼핑몰 식별자(읽기만, 아무것도 바꾸지 않음). 알 수 없으면 null
  currentShopKey(): Promise<string | null>;
  // 기본: 쿠키·저장소·임시파일까지 지운다.
  // keepForResume: 고객 행동(로그인·2단계 인증·CAPTCHA·권한 승인) 대기로 멈출 때. 실행기는 이 작업의 쿠키·저장소·자격증명을
  // 암호화하고 작업 id에만 묶어 보관한다(다른 작업 id로는 풀리지 않음). 다음 open(같은 작업)에서 복원한 뒤 보관본을 지운다.
  // 작업이 끝나면(완료·취소·실패·마감) 서버가 discard로 바로 지운다(worker.ts purgeEndedBrowserState).
  close(opts?: { keepForResume?: boolean }): Promise<void>;
}

export interface BrowserExecutor {
  // 작업마다 새 browser context. 다른 작업·판매자와 쿠키·저장소를 나누지 않는다(같은 작업의 보관본만 복원).
  open(scope: JobScope): Promise<BrowserSession>;
  // 그 작업의 보관본을 지운다(완료·취소·실패·고객 행동 마감 때 서버가 요청). 없으면 아무것도 안 한다. 지운 뒤에는 복원할 수 없다.
  discard(scope: JobScope): Promise<void>;
}

export interface ObsBridge {
  observe(scope: JobScope): Promise<Observation>;
  perform(scope: JobScope, action: AutomationAction): Promise<ActionOutcome>;
  // 연결된 로컬 도구의 OBS pairing id(읽기만). 연결 안 됐거나 알 수 없으면 null
  currentPairingId(scope: JobScope): Promise<string | null>;
}

export interface SecretVault {
  forJob(scope: JobScope): Promise<JobSecrets>;
}

export type AutomationRuntime = { planner: AutomationPlanner; browser: BrowserExecutor; obs: ObsBridge; vault: SecretVault };

// ───── 안전장치 ─────

const MAX_PAGE_TEXT = 8_000;
const REDACTED = "[비밀값]";

// 비밀값을 지우고 길이를 자른다. 비밀값이 짧으면(8자 미만) 오탐이 많아 지우지 않는다 — 그런 값은 비밀로 쓰지 않는다.
export function sanitizeObservation(o: Observation, secrets: JobSecrets): SafeObservation {
  const strip = (s: string) =>
    Object.values(secrets)
      .filter((v) => v.length >= 8)
      .reduce((acc, v) => acc.split(v).join(REDACTED), s);
  return { url: o.url ? strip(o.url) : null, untrustedPageText: strip(o.text).slice(0, MAX_PAGE_TEXT) };
}

// 관리 화면 이동은 이 호스트(와 하위 도메인)만. https만 허용한다.
export const ALLOWED_HOSTS = ["cafe24.com", "cafe24api.com"] as const;

export const ALLOWED_ACTIONS: Record<StepKind, readonly AutomationAction["type"][]> = {
  browser: ["navigate", "click", "fill", "request_customer", "step_done"],
  obs: ["obs_add_overlay_source", "obs_apply_display_settings", "request_customer", "step_done"],
  verify: ["send_test_event", "check_overlay_shows_test_event", "request_customer", "step_done"],
};

const SECRET_REFS: readonly SecretRef[] = ["webhook_url", "webhook_secret"];
const CUSTOMER_ACTIONS: readonly AutomationCustomerAction[] = ["LOGIN", "TWO_FACTOR", "CAPTCHA", "PERMISSION_GRANT", "LOCAL_TOOL"];

function hostAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username || u.password) return false;
  return ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

// 판단 모델이 낸 행동을 실행 전에 검사한다. 화면 글에 숨은 지시(악성 페이지)를 따른 결과도 여기서 걸러진다:
// 단계에 없는 행동, 허용 밖 주소, 비밀값을 화면 글로 옮겨 적기, 모르는 고객 행동은 모두 거부한다.
// 비밀값을 넣어도 되는 칸: 비밀 참조 → 이 단계에서 허용된 입력 칸 이름 목록. 작업서가 단계마다 미리 정한다.
// 목록에 없는 비밀 참조·칸은 거부한다(악성 화면 지시로 다른 칸·다른 단계에 비밀을 넣지 못하게). 작업서가 없으면 비밀값을 쓰지 못한다.
export type SecretTargets = Readonly<Partial<Record<SecretRef, readonly string[]>>>;

export function validateDecision(
  step: Step,
  d: PlannerDecision,
  secrets: JobSecrets,
  secretTargets: SecretTargets = {},
): { ok: true } | { ok: false; reason: string } {
  const a = d.action;
  if (!Number.isInteger(d.costWon) || d.costWon < 0) return { ok: false, reason: "bad_cost" };
  if (!a || !ALLOWED_ACTIONS[step.kind].includes(a.type)) return { ok: false, reason: "action_not_allowed" };
  switch (a.type) {
    case "navigate":
      return hostAllowed(a.url) ? { ok: true } : { ok: false, reason: "host_not_allowed" };
    case "click":
      return typeof a.target === "string" && a.target.length > 0 && a.target.length <= 200 ? { ok: true } : { ok: false, reason: "bad_target" };
    case "fill": {
      if (typeof a.target !== "string" || !a.target || a.target.length > 200) return { ok: false, reason: "bad_target" };
      if ("secretRef" in a.value) {
        if (!SECRET_REFS.includes(a.value.secretRef)) return { ok: false, reason: "bad_secret_ref" };
        return secretTargets[a.value.secretRef]?.includes(a.target) ? { ok: true } : { ok: false, reason: "secret_target_not_allowed" };
      }
      const text = a.value.text;
      if (typeof text !== "string" || text.length > 200) return { ok: false, reason: "bad_text" };
      // 모델이 어떤 경로로든 비밀값을 알아내 직접 적으려 하면 막는다
      if (Object.values(secrets).some((v) => v.length >= 8 && text.includes(v))) return { ok: false, reason: "secret_in_text" };
      return { ok: true };
    }
    case "request_customer":
      return CUSTOMER_ACTIONS.includes(a.action) ? { ok: true } : { ok: false, reason: "bad_customer_action" };
    default:
      return { ok: true };
  }
}
