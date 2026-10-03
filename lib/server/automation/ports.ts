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

export type PlannerInput = { step: Step; observation: SafeObservation; history: readonly string[] };
// costWon: 이 판단 호출에 든 비용(원 추정). 작업당 비용 상한 계산에 쓴다.
export type PlannerDecision = { action: AutomationAction; costWon: number };

export interface AutomationPlanner {
  decide(input: PlannerInput): Promise<PlannerDecision>;
}

export type ActionOutcome =
  | { kind: "ok"; stepDone: boolean; verified?: boolean }
  | { kind: "needs_customer"; action: AutomationCustomerAction }
  | { kind: "retryable"; reason: string }
  | { kind: "fatal"; reason: string };

export interface BrowserSession {
  readonly id: string;
  observe(): Promise<Observation>;
  perform(action: AutomationAction, secrets: JobSecrets): Promise<ActionOutcome>;
  // 쿠키·저장소·임시파일까지 지운다
  close(): Promise<void>;
}

export interface BrowserExecutor {
  // 작업마다 새 브라우저 context. 다른 작업·판매자와 쿠키·저장소를 나누지 않는다.
  open(scope: JobScope): Promise<BrowserSession>;
}

export interface ObsBridge {
  observe(scope: JobScope): Promise<Observation>;
  perform(scope: JobScope, action: AutomationAction): Promise<ActionOutcome>;
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

const ALLOWED_ACTIONS: Record<StepKind, readonly AutomationAction["type"][]> = {
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
export function validateDecision(step: Step, d: PlannerDecision, secrets: JobSecrets): { ok: true } | { ok: false; reason: string } {
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
      if ("secretRef" in a.value) return SECRET_REFS.includes(a.value.secretRef) ? { ok: true } : { ok: false, reason: "bad_secret_ref" };
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
