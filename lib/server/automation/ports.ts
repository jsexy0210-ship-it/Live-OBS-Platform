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

// 화면 요소(실행기가 구조화해 준다). 판단 모델에는 조작에 필요한 종류(버튼·링크·제목·폼 라벨·안내 문구)만 넘기고,
// 표 본문·주문/회원 목록·입력값은 넘기지 않는다(구매자 개인정보 차단).
export type ObservedElement = { kind: "button" | "link" | "heading" | "label" | "notice" | "table" | "list" | "input"; text: string };
// text: 화면 전체 글(서버 안에서 작업서 화면 단서 대조에만 쓰고 판단 모델에 보내지 않는다)
export type Observation = { url: string | null; text: string; elements?: readonly ObservedElement[] };
// 모델에 넘기는 관찰. 조작 요소만 추리고 비밀값·개인정보를 가리며, 화면 글은 신뢰하지 않는 데이터로만 넘긴다.
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
  // 지운 범위에는 tombstone을 남겨, 그 뒤 늦게 끝난 행동·닫기(keepForResume 포함)가 보관본·행동 키를 다시 쓰는 것을 거부한다
  // (행동 결과는 fatal "scope_discarded"). 정리가 진행 중인 실행보다 먼저 끝나도 자료가 되살아나지 않게 하는 규칙이다.
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
  // 지운 범위에는 tombstone을 남겨, 늦게 끝난 행동이 연결 정보·행동 키를 다시 남기지 않게 거부한다(결과는 fatal "scope_discarded").
  discard(scope: JobScope): Promise<void>;
}

export interface SecretVault {
  forJob(scope: JobScope): Promise<JobSecrets>;
}

export type AutomationRuntime = { planner: AutomationPlanner; browser: BrowserExecutor; obs: ObsBridge; vault: SecretVault };

// ───── 안전장치 ─────

const MAX_PAGE_TEXT = 8_000;
const REDACTED = "[비밀값]";

const PLANNER_ELEMENT_KINDS: readonly ObservedElement["kind"][] = ["button", "link", "heading", "label", "notice"];
// 공통 UI 어휘. 판단 모델에는 이 목록과 작업서 단계 문구에 정확히 있는 글만 원문으로 보낸다(이름은 패턴으로 가릴 수 없어 허용 목록으로 막는다).
export const COMMON_UI_WORDS: readonly string[] = ["저장", "확인", "취소", "다음", "이전", "닫기", "완료", "설치", "설정", "로그인", "로그아웃", "관리자", "메뉴", "검색", "적용", "동의", "OBS 연결됨", "OBS 연결 안 됨"];
const PLACEHOLDER = "[문구]";

// 남은 글의 개인정보 패턴을 가린다(이메일·전화번호·주소·주문번호 같은 긴 숫자열). 이름은 패턴으로 못 잡으므로 표·목록·입력값을 통째로 뺀다.
export function maskPersonal(s: string): string {
  return s
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[이메일]")
    .replace(/(?:\+?82[-\s.]?)?0\d{1,2}[-\s.]?\d{3,4}[-\s.]?\d{4}/g, "[전화번호]")
    .replace(/[가-힣]+(?:특별시|광역시|특별자치시|특별자치도|시|도)\s+[가-힣]+(?:시|군|구)(?:\s+[가-힣0-9]+(?:구|읍|면|동|리|로|길))*(?:\s*\d+(?:-\d+)?)?/g, "[주소]")
    .replace(/[가-힣0-9]+(?:로|길)\s*\d+(?:-\d+)?/g, "[주소]")
    .replace(/\d[\d-]{5,}\d/g, "[번호]");
}

// 판단 모델 입력을 만든다: 화면 본문을 그대로 보내지 않고 조작 요소만 추린다. 요소 글은 허용 어휘(공통 UI 어휘 + 작업서 단계 문구, vocabulary)에
// 정확히 있을 때만 원문으로 보내고, 그 밖은 자리표시 「[문구]」와 요소 번호만 보낸다(이름이 든 안내·링크 차단). 남은 글도 비밀값·개인정보 패턴을 가린다.
// 주소는 출처·경로만(쿼리·조각에 개인정보가 실릴 수 있음). 비밀값이 짧으면(8자 미만) 오탐이 많아 지우지 않는다 — 그런 값은 비밀로 쓰지 않는다.
export function sanitizeObservation(o: Observation, secrets: JobSecrets, vocabulary: readonly string[] = COMMON_UI_WORDS): SafeObservation {
  const strip = (s: string) =>
    Object.values(secrets)
      .filter((v) => v.length >= 8)
      .reduce((acc, v) => acc.split(v).join(REDACTED), s);
  const allowed = new Set([...COMMON_UI_WORDS, ...vocabulary]);
  const text = (o.elements ?? [])
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => PLANNER_ELEMENT_KINDS.includes(e.kind))
    .map(({ e, i }) => `[${e.kind}#${i + 1}] ${allowed.has(e.text.trim()) ? e.text.trim() : PLACEHOLDER}`)
    .join("\n");
  let url: string | null = null;
  if (o.url) {
    try {
      const u = new URL(o.url);
      url = maskPersonal(strip(`${u.origin}${u.pathname}`));
    } catch {
      url = null;
    }
  }
  return { url, untrustedPageText: maskPersonal(strip(text)).slice(0, MAX_PAGE_TEXT) };
}

// 관리 화면 이동은 이 호스트(와 하위 도메인)만. https만 허용한다.
export const ALLOWED_HOSTS = ["cafe24.com", "cafe24api.com"] as const;

export const ALLOWED_ACTIONS: Record<StepKind, readonly AutomationAction["type"][]> = {
  browser: ["navigate", "click", "fill", "request_customer", "step_done"],
  obs: ["obs_add_overlay_source", "obs_apply_display_settings", "request_customer", "step_done"],
  verify: ["send_test_event", "check_overlay_shows_test_event", "request_customer", "step_done"],
};

const SECRET_REFS: readonly SecretRef[] = ["webhook_url", "webhook_secret"];
// 설치와 무관하고 되돌리기 어려운 조작의 단어. 이런 대상은 작업서 허용 목록에 있어도 누르거나 입력하지 않는다(작업서 실수 방어).
export const DANGEROUS_TARGET_WORDS = ["삭제", "탈퇴", "해지", "초기화", "권한", "계정", "비밀번호", "결제", "환불", "delete", "remove", "permission", "account", "password"] as const;
const dangerous = (target: string) => DANGEROUS_TARGET_WORDS.some((w) => target.toLowerCase().includes(w));
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
// 이동 규칙: 이 작업의 쇼핑몰 호스트(정확히 일치)와 단계별 허용 경로 접두·쿼리 키. 없으면 이동할 수 없다.
export type NavRules = { shopHost: string | null | undefined; pathPrefixes: readonly string[]; queryKeys: readonly string[] };

export function validateDecision(
  step: Step,
  d: PlannerDecision,
  secrets: JobSecrets,
  secretTargets: SecretTargets = {},
  // 이 단계에서 누르거나(click) 글을 넣어도(비밀값 아닌 fill) 되는 대상. 작업서가 단계마다 정한다. 목록 밖이면 거부한다
  // (악성 화면 지시로 삭제·권한·계정 설정 같은 설치와 무관한 칸을 누르지 못하게). 작업서가 없으면 누르거나 넣을 수 없다.
  allowedTargets: readonly string[] = [],
  nav: NavRules | null = null,
): { ok: true } | { ok: false; reason: string } {
  const a = d.action;
  if (!Number.isInteger(d.costWon) || d.costWon < 0) return { ok: false, reason: "bad_cost" };
  if (!a || !ALLOWED_ACTIONS[step.kind].includes(a.type)) return { ok: false, reason: "action_not_allowed" };
  switch (a.type) {
    case "navigate": {
      if (!hostAllowed(a.url)) return { ok: false, reason: "host_not_allowed" };
      const u = new URL(a.url);
      // 호스트는 이 작업의 쇼핑몰 호스트만(같은 플랫폼의 다른 몰·중앙 호스트 거부)
      if (!nav?.shopHost || u.hostname !== nav.shopHost) return { ok: false, reason: "host_not_allowed" };
      // 경로는 단계별 허용 접두, 쿼리는 정한 키만, 조각(#)은 쓰지 않는다
      if (!nav.pathPrefixes.some((p) => p.startsWith("/") && u.pathname.startsWith(p))) return { ok: false, reason: "target_not_allowed" };
      if ([...u.searchParams.keys()].some((k) => !nav.queryKeys.includes(k)) || u.hash) return { ok: false, reason: "target_not_allowed" };
      return { ok: true };
    }
    case "click":
      if (typeof a.target !== "string" || !a.target || a.target.length > 200) return { ok: false, reason: "bad_target" };
      if (dangerous(a.target)) return { ok: false, reason: "dangerous_target" };
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
      if (dangerous(a.target)) return { ok: false, reason: "dangerous_target" };
      return allowedTargets.includes(a.target) ? { ok: true } : { ok: false, reason: "target_not_allowed" };
    }
    case "request_customer":
      return CUSTOMER_ACTIONS.includes(a.action) ? { ok: true } : { ok: false, reason: "bad_customer_action" };
    default:
      return { ok: true };
  }
}
