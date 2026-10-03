import type { Prisma } from "@prisma/client";

// 파트너스 가입 신청 필수 동의(PF-007-1, MASTER 결정 2026-10-04 대기열 3번 A안): 대표자 휴대폰 본인확인을 시작하기 전에 받는다.
// 본인확인 시작 요청이 동의 값과 화면에 보여 준 문서 버전을 보내고, 서버는 지금 버전과 같을 때만 시작한다(문자 비용을 쓰기 전에 거절).
// 동의 기록은 본인확인 요청(IdentityVerification.signupConsent)에 묶고, 신청을 마치면 대표자 계정(SellerUser.signupConsent)으로 옮긴다.
// 문서(PF-008 이용약관·PF-009 개인정보 수집·이용)가 바뀌면 버전을 올린다.
export const SELLER_SIGNUP_CONSENT_VERSIONS = {
  terms: "2026-10-04.v1", // 파트너스 이용약관(PF-008)
  privacy: "2026-10-04.v1", // 개인정보 수집·이용(PF-009)
} as const;

export type SellerSignupConsent = { termsVersion: string; privacyVersion: string; agreedAt: string };

export type SellerConsentFailure = "terms_required" | "consent_outdated";

export const SELLER_CONSENT_MESSAGES: Record<SellerConsentFailure, string> = {
  terms_required: "필수 약관에 동의해 주세요",
  consent_outdated: "약관이 바뀌었어요. 다시 확인하고 동의해 주세요",
};
export const SELLER_CONSENT_STATUS: Record<SellerConsentFailure, number> = { terms_required: 400, consent_outdated: 409 };

// 본문: { agreedTerms: true, agreedPrivacy: true, termsVersion, privacyVersion }. 둘 중 하나라도 true가 아니면 terms_required,
// 화면이 보여 준 문서 버전이 지금과 다르면 consent_outdated(동의한 내용을 확인할 수 없어 시작하지 않는다).
export function parseSellerSignupConsent(raw: unknown, now: Date): { ok: true; consent: SellerSignupConsent } | { ok: false; reason: SellerConsentFailure } {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (b.agreedTerms !== true || b.agreedPrivacy !== true) return { ok: false, reason: "terms_required" };
  if (b.termsVersion !== SELLER_SIGNUP_CONSENT_VERSIONS.terms || b.privacyVersion !== SELLER_SIGNUP_CONSENT_VERSIONS.privacy) return { ok: false, reason: "consent_outdated" };
  return { ok: true, consent: { termsVersion: SELLER_SIGNUP_CONSENT_VERSIONS.terms, privacyVersion: SELLER_SIGNUP_CONSENT_VERSIONS.privacy, agreedAt: now.toISOString() } };
}

// DB에서 읽은 값을 다시 확인한다(형식이 틀리거나 없으면 null).
export function readSellerSignupConsent(v: Prisma.JsonValue | null | undefined): SellerSignupConsent | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (typeof c.termsVersion !== "string" || typeof c.privacyVersion !== "string" || typeof c.agreedAt !== "string") return null;
  return { termsVersion: c.termsVersion, privacyVersion: c.privacyVersion, agreedAt: c.agreedAt };
}
