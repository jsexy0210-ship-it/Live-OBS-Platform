import { CUSTOMER_ACTIONS, type ActionOutcome, type JobSecrets, type VerificationEvidence } from "./ports";

// 외부(실행기·로컬 도구·판단 모델)에서 들어온 값은 저장·기록 전에 여기서만 검증·정규화한다.
// 원문을 그대로 저장하지 않는다: 실패 사유는 정해 둔 코드로만, 식별자는 길이·문자를 검사해 자르지 않고 거절, 비용은 DB 정수 범위 안으로.

// 실행기 계약(ports.ts)의 실패 사유 코드. 목록 밖(외부 화면 문구·비밀값이 섞일 수 있는 원문)은 executor_error로만 남긴다.
const EXECUTOR_REASONS: ReadonlySet<string> = new Set(["page_mismatch", "pairing_mismatch", "scope_discarded", "timeout", "page_timeout", "obs_busy", "admin_error"]);
export const executorReason = (raw: unknown): string => (typeof raw === "string" && EXECUTOR_REASONS.has(raw) ? raw : "executor_error");

// 외부 식별자(쇼핑몰 id·OBS pairing id): 1~200자, 제어 문자 없음. 자르면 다른 값과 같아질 수 있어 자르지 않고 거절한다.
export const EXTERNAL_ID_MAX = 200;
export type ExternalId = { ok: true; value: string | null } | { ok: false };
export function externalId(raw: unknown): ExternalId {
  if (raw === null || raw === undefined || raw === "") return { ok: true, value: null };
  if (typeof raw !== "string" || raw.length > EXTERNAL_ID_MAX || /[\u0000-\u001f\u007f]/.test(raw)) return { ok: false };
  return { ok: true, value: raw };
}

// 비용·횟수 열(Int4)의 최대값. 판단 모델이 낸 비용 합계는 이 값을 넘겨 쓰지 않는다.
export const DB_INT_MAX = 2_147_483_647;

// 검증 증거: 키 형식·개수·값 길이를 제한하고, 글 값에 작업 비밀값이 있으면 가린다.
function evidenceOf(raw: VerificationEvidence | undefined, secrets: JobSecrets): VerificationEvidence | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw).slice(0, 20)) {
    if (!/^[A-Za-z0-9_]{1,40}$/.test(k)) continue;
    if (typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) out[k] = v;
    else if (typeof v === "string") out[k] = Object.values(secrets).reduce((s, sec) => (sec.length >= 4 ? s.split(sec).join("[비밀값]") : s), v).slice(0, 200);
  }
  return out;
}

// 실행기·로컬 도구의 행동 결과를 엔진이 쓰기 전에 정규화한다. 식별자가 형식에 맞지 않으면 그 결과를 쓰지 않고 실패로 바꾼다.
export function fromExecutor(out: ActionOutcome, secrets: JobSecrets): ActionOutcome {
  switch (out.kind) {
    case "fatal":
    case "retryable":
      return { kind: out.kind, reason: executorReason(out.reason) };
    case "needs_customer":
      return CUSTOMER_ACTIONS.includes(out.action) ? out : { kind: "fatal", reason: "executor_error" };
    case "ok": {
      const pairing = externalId(out.pairingId);
      const facts = out.facts ? { shop: externalId(out.facts.shopKey), pc: externalId(out.facts.obsPairingId) } : null;
      if (!pairing.ok || (facts && !facts.pc.ok)) return { kind: "fatal", reason: "pc_identity_invalid" };
      if (facts && !facts.shop.ok) return { kind: "fatal", reason: "shop_identity_invalid" };
      return {
        ...out,
        pairingId: pairing.value ?? undefined,
        facts: facts && facts.shop.ok && facts.pc.ok ? { ...(facts.shop.value ? { shopKey: facts.shop.value } : {}), ...(facts.pc.value ? { obsPairingId: facts.pc.value } : {}) } : undefined,
        evidence: evidenceOf(out.evidence, secrets),
      };
    }
  }
}
