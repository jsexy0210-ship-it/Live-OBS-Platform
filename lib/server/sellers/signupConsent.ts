import type { Prisma } from "@prisma/client";

// 파트너스 가입 신청 필수 동의(PF-007-1, MASTER 결정 2026-10-04 대기열 3번 A안): 대표자 휴대폰 본인확인을 시작하기 전에 받는다.
// 본인확인 시작 요청이 동의 값과 화면에 보여 준 문서 버전을 보내고, 서버는 지금 버전과 같을 때만 시작한다(문자 비용을 쓰기 전에 거절).
// 동의 기록은 본인확인 요청(IdentityVerification.signupConsent)에 묶고, 신청을 마치면 대표자 계정(SellerUser.signupConsent)으로 옮긴다.
// 문서(PF-008 이용약관, 개인정보 수집·이용 동의: 개인정보처리방침(PF-009)과 별도 문서)가 바뀌면 버전을 올린다.
export const SELLER_SIGNUP_CONSENT_VERSIONS = {
  terms: "2026-10-04.v1", // 파트너스 이용약관(PF-008)
  privacy: "2026-10-04.v1", // 개인정보 수집·이용 동의(처리방침 PF-009와 별도 문서)
  policy: "2026-10-06.v1", // 파트너스 운영 정책(구매자 개인정보 보호·방송 표시 규칙, PF-007-1 필수 동의)
  marketing: "2026-10-06.v1", // 새 기능·혜택 소식 받기(선택 동의)
} as const;

// 운영 정책 동의를 필수로 받을지. 가입 화면(PF-007-1)이 정본의 「파트너스 운영 정책」 체크를 보내기 전에는 false로 두어
// 기존 화면이 막히지 않게 한다. 화면이 보내기 시작하는 변경에서 true로 바꾼다. 보내 온 값은 false여도 확인·저장한다.
export const SELLER_POLICY_REQUIRED = false;

// policyVersion: 운영 정책 동의 문서 버전(동의했을 때만). marketing: 선택 동의(동의했을 때 버전·시각 marketingAt)
export type SellerSignupConsent = {
  termsVersion: string;
  privacyVersion: string;
  agreedAt: string;
  policyVersion?: string;
  marketingVersion?: string;
  marketingAt?: string;
};

export type SellerConsentFailure = "terms_required" | "consent_outdated";

export const SELLER_CONSENT_MESSAGES: Record<SellerConsentFailure, string> = {
  terms_required: "필수 약관에 동의해 주세요",
  consent_outdated: "약관이 바뀌었어요. 다시 확인하고 동의해 주세요",
};
export const SELLER_CONSENT_STATUS: Record<SellerConsentFailure, number> = { terms_required: 400, consent_outdated: 409 };

// 본문: { agreedTerms: true, agreedPrivacy: true, termsVersion, privacyVersion } + 운영 정책 { agreedPolicy: true, policyVersion } + 선택 { agreedMarketing: true, marketingVersion }.
// 필수 둘 중 하나라도 true가 아니면 terms_required(운영 정책은 SELLER_POLICY_REQUIRED일 때 필수, 보냈다면 false는 거절).
// 화면이 보여 준 문서 버전이 지금과 다르면 consent_outdated(동의한 내용을 확인할 수 없어 시작하지 않는다). 선택 동의는 거절해도 가입에 영향이 없다.
export function parseSellerSignupConsent(raw: unknown, now: Date): { ok: true; consent: SellerSignupConsent } | { ok: false; reason: SellerConsentFailure } {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (b.agreedTerms !== true || b.agreedPrivacy !== true) return { ok: false, reason: "terms_required" };
  const policySent = b.agreedPolicy !== undefined || b.policyVersion !== undefined;
  if ((SELLER_POLICY_REQUIRED || policySent) && b.agreedPolicy !== true) return { ok: false, reason: "terms_required" };
  if (b.termsVersion !== SELLER_SIGNUP_CONSENT_VERSIONS.terms || b.privacyVersion !== SELLER_SIGNUP_CONSENT_VERSIONS.privacy) return { ok: false, reason: "consent_outdated" };
  if ((SELLER_POLICY_REQUIRED || policySent) && b.policyVersion !== SELLER_SIGNUP_CONSENT_VERSIONS.policy) return { ok: false, reason: "consent_outdated" };
  const at = now.toISOString();
  const consent: SellerSignupConsent = { termsVersion: SELLER_SIGNUP_CONSENT_VERSIONS.terms, privacyVersion: SELLER_SIGNUP_CONSENT_VERSIONS.privacy, agreedAt: at };
  if (b.agreedPolicy === true) consent.policyVersion = SELLER_SIGNUP_CONSENT_VERSIONS.policy;
  if (b.agreedMarketing === true) {
    if (b.marketingVersion !== SELLER_SIGNUP_CONSENT_VERSIONS.marketing) return { ok: false, reason: "consent_outdated" };
    consent.marketingVersion = SELLER_SIGNUP_CONSENT_VERSIONS.marketing;
    consent.marketingAt = at;
  }
  return { ok: true, consent };
}

// DB에서 읽은 값을 다시 확인한다(형식이 틀리거나 없으면 null).
export function readSellerSignupConsent(v: Prisma.JsonValue | null | undefined): SellerSignupConsent | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (typeof c.termsVersion !== "string" || typeof c.privacyVersion !== "string" || typeof c.agreedAt !== "string") return null;
  const out: SellerSignupConsent = { termsVersion: c.termsVersion, privacyVersion: c.privacyVersion, agreedAt: c.agreedAt };
  if (typeof c.policyVersion === "string") out.policyVersion = c.policyVersion;
  if (typeof c.marketingVersion === "string" && typeof c.marketingAt === "string") {
    out.marketingVersion = c.marketingVersion;
    out.marketingAt = c.marketingAt;
  }
  return out;
}
