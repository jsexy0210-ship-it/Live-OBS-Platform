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
  // actionKey: 변경 행동(클릭·입력·OBS 설정·테스트 주문)에만 붙는 고정 키(작업 id·단계·행동 의미의 해시, 순번과 무관). 실행기는 같은 키로
  // 이미 성공한 행동을 다시 적용하지 않고 그때 결과를 돌려준다(작업자가 죽은 뒤 회수·재실행해도 중복 적용 없음).
  // 키 기록도 보관 자료처럼 작업에만 묶고 작업이 끝나면 지운다. 키가 없는 행동(이동·확인)은 매번 실행한다.
  perform(action: AutomationAction, secrets: JobSecrets, actionKey?: string): Promise<ActionOutcome>;
  // 지금 로그인된 관리 화면의 쇼핑몰 식별자(읽기만, 아무것도 바꾸지 않음). 알 수 없으면 null
  currentShopKey(): Promise<string | null>;
  // 지금 문서의 주소(리다이렉트 뒤 실제 출처, 읽기만). 알 수 없으면 null. 비밀값을 넣기 직전에 확인한다.
  currentUrl(): Promise<string | null>;
  // 기본: 쿠키·저장소·임시파일까지 지운다.
  // keepForResume: 고객 행동(로그인·2단계 인증·CAPTCHA·권한 승인) 대기로 멈출 때. 실행기는 이 작업의 쿠키·저장소·자격증명과
  // 임시 파일(화면 캡처·내려받은 파일·실행 기록)을
  // 암호화하고 작업 id에만 묶어 보관한다(다른 작업 id로는 풀리지 않음). 다음 open(같은 작업)에서 복원한 뒤 보관본을 지운다.
  // 작업이 끝나면(완료·취소·실패·마감) 서버가 discard로 바로 지운다(worker.ts purgeEndedBrowserState).
  close(opts?: { keepForResume?: boolean }): Promise<void>;
}

// 실제 실행기가 지켜야 할 접속 조건(정본 c4cc711). 서버 쪽 검사(validateDecision의 허용 호스트·https·기본 포트)만으로는
// DNS 바꿔치기·리다이렉트로 내부망에 닿는 것을 막을 수 없으므로 실행기가 접속 단계에서 직접 막는다.
// - navigate·리다이렉트·하위 요청 모두: DNS 확인 뒤 실제 접속 IP와 리다이렉트마다 다시 확인한 IP가
//   localhost(127.0.0.0/8, ::1)·사설망(10/8, 172.16/12, 192.168/16, fc00::/7)·링크로컬(169.254/16, fe80::/10)·
//   클라우드 메타데이터(169.254.169.254 등)·0.0.0.0이면 거부한다. 리다이렉트는 횟수 상한을 둔다.
// - https와 기본 포트만, 허용 호스트(ALLOWED_HOSTS) 밖으로 리다이렉트되면 거부한다.
// - 거부하면 retryable이 아니라 fatal로 돌려준다(같은 주소를 반복 시도하지 않게).
export interface BrowserExecutor {
  // 작업마다 새 browser context. 다른 작업·판매자와 쿠키·저장소를 나누지 않는다(같은 작업의 보관본만 복원).
  open(scope: JobScope): Promise<BrowserSession>;
  // 그 작업의 보관본(쿠키·저장소·자격증명·임시 파일)과 행동 키 기록을 지운다. 끝난 모든 작업(완료·취소·실패·마감)에 서버가
  // 한 번씩 요청한다(고객 대기가 없었던 작업 포함). 없으면 아무것도 안 한다. 지운 뒤에는 복원할 수 없다.
  discard(scope: JobScope): Promise<void>;
}

export interface ObsBridge {
  observe(scope: JobScope): Promise<Observation>;
  // actionKey: 위와 같다. 로컬 도구는 같은 키로 이미 성공한 OBS 변경(소스 추가 등)을 다시 적용하지 않는다.
  perform(scope: JobScope, action: AutomationAction, actionKey?: string): Promise<ActionOutcome>;
  // 연결된 로컬 도구의 OBS pairing id(읽기만). 연결 안 됐거나 알 수 없으면 null
  currentPairingId(scope: JobScope): Promise<string | null>;
  // 이 작업의 OBS 연결 정보(로컬 도구 연결 토큰 등)와 행동 키 기록을 지운다. 고객 대기 중에는 암호화해 작업에만 묶어 두고,
  // 작업이 끝나면(완료·취소·실패·마감, 고객 대기가 없었던 작업 포함) 서버가 이것으로 바로 지운다. 지운 뒤에는 다시 쓸 수 없다.
  discard(scope: JobScope): Promise<void>;
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

export function hostAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  // https·기본 포트만(사용자 정보가 든 주소 거부)
  if (u.protocol !== "https:" || u.port !== "" || u.username || u.password) return false;
  return ALLOWED_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
}

// 비밀값을 넣어도 되는 주소: 이동 허용 호스트이면서, 작업 대상 쇼핑몰 호스트와 정확히 같고, 경로가 관리자 경로 접두사로 시작해야 한다.
// 관리자 화면이 쇼핑몰 자체 하위 도메인(<몰>.cafe24.com)에 있어 호스트만으로는 판매자가 꾸미는 쇼핑몰 앞 화면과 가를 수 없다.
// 로그인 상태 단서는 엔진이 관찰 글로 따로 본다.
export function secretOriginAllowed(raw: string, shopHost: string | null | undefined, pathPrefixes: readonly string[]): boolean {
  if (!shopHost || !hostAllowed(raw)) return false;
  const u = new URL(raw);
  return u.hostname === shopHost && pathPrefixes.some((p) => p.startsWith("/") && u.pathname.startsWith(p));
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
  // 이 단계에서 누르거나(click) 글을 넣어도(비밀값 아닌 fill) 되는 대상. 작업서가 단계마다 정한다. 목록 밖이면 거부한다
  // (악성 화면 지시로 삭제·권한·계정 설정 같은 설치와 무관한 칸을 누르지 못하게). 작업서가 없으면 누르거나 넣을 수 없다.
  allowedTargets: readonly string[] = [],
): { ok: true } | { ok: false; reason: string } {
  const a = d.action;
  if (!Number.isInteger(d.costWon) || d.costWon < 0) return { ok: false, reason: "bad_cost" };
  if (!a || !ALLOWED_ACTIONS[step.kind].includes(a.type)) return { ok: false, reason: "action_not_allowed" };
  switch (a.type) {
    case "navigate":
      return hostAllowed(a.url) ? { ok: true } : { ok: false, reason: "host_not_allowed" };
    case "click":
      if (typeof a.target !== "string" || !a.target || a.target.length > 200) return { ok: false, reason: "bad_target" };
      return allowedTargets.includes(a.target) ? { ok: true } : { ok: false, reason: "target_not_allowed" };
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
      return allowedTargets.includes(a.target) ? { ok: true } : { ok: false, reason: "target_not_allowed" };
    }
    case "request_customer":
      return CUSTOMER_ACTIONS.includes(a.action) ? { ok: true } : { ok: false, reason: "bad_customer_action" };
    default:
      return { ok: true };
  }
}
