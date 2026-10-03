import type { Prisma } from "@prisma/client";
import { REJOIN_RETENTION_CONSENT_VERSION } from "./rejoin";

// 구매자 가입 필수 동의(PRODUCT_SCOPE 「동의 순서」, 2026-10-03): 휴대폰 본인확인을 요청하기 전에 받는다.
// 본인확인 시작 요청이 동의 값과 화면에 보여 준 문서 버전을 보내고, 서버는 지금 버전과 같을 때만 시작한다.
// 동의 기록은 본인확인 요청(IdentityVerification.signupConsent)에 묶고, 가입을 마치면 회원(BuyerMember.signupConsent)으로 옮긴다.
// 문서(docs/terms/*_TEMPLATE.md)가 바뀌면 버전을 올린다.
export const SIGNUP_CONSENT_VERSIONS = {
  terms: "2026-10-03.v1", // 이용약관(BUYER_TERMS_TEMPLATE)
  privacy: "2026-10-03.v1", // 개인정보 수집·이용(PRIVACY_CONSENT_TEMPLATE)
  rejoinRetention: REJOIN_RETENTION_CONSENT_VERSION, // 재가입 제한 정보 보관(같은 문서 하단, 재가입 제한을 켠 쇼핑몰만)
} as const;

export type SignupConsent = {
  termsVersion: string;
  privacyVersion: string;
  // 재가입 제한을 켠 쇼핑몰에서만: 동의한 문서 버전과 그때 안내한 기간(일)
  rejoinRetention: { version: string; days: number } | null;
  agreedAt: string;
};

export type ConsentFailure = "terms_required" | "rejoin_consent_required" | "consent_outdated";

// 본문: { agreedTerms: true, agreedPrivacy: true, termsVersion, privacyVersion, agreedRejoinRetention?, rejoinRetentionVersion? }.
// rejoinDays: 지금 재가입 제한 기간(꺼져 있으면 null). 꺼진 쇼핑몰은 보관 동의 값을 보지 않는다.
export function parseSignupConsent(raw: unknown, rejoinDays: number | null, now: Date): { ok: true; consent: SignupConsent } | { ok: false; reason: ConsentFailure } {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (b.agreedTerms !== true || b.agreedPrivacy !== true) return { ok: false, reason: "terms_required" };
  if (rejoinDays !== null && b.agreedRejoinRetention !== true) return { ok: false, reason: "rejoin_consent_required" };
  if (b.termsVersion !== SIGNUP_CONSENT_VERSIONS.terms || b.privacyVersion !== SIGNUP_CONSENT_VERSIONS.privacy) return { ok: false, reason: "consent_outdated" };
  if (rejoinDays !== null && b.rejoinRetentionVersion !== SIGNUP_CONSENT_VERSIONS.rejoinRetention) return { ok: false, reason: "consent_outdated" };
  return {
    ok: true,
    consent: {
      termsVersion: SIGNUP_CONSENT_VERSIONS.terms,
      privacyVersion: SIGNUP_CONSENT_VERSIONS.privacy,
      rejoinRetention: rejoinDays !== null ? { version: SIGNUP_CONSENT_VERSIONS.rejoinRetention, days: rejoinDays } : null,
      agreedAt: now.toISOString(),
    },
  };
}

// DB에서 읽은 값을 다시 확인한다(형식이 틀리면 null).
export function readSignupConsent(v: Prisma.JsonValue | null | undefined): SignupConsent | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const c = v as Record<string, unknown>;
  if (typeof c.termsVersion !== "string" || typeof c.privacyVersion !== "string" || typeof c.agreedAt !== "string") return null;
  const r = c.rejoinRetention as Record<string, unknown> | null | undefined;
  const rejoinRetention = r && typeof r.version === "string" && Number.isInteger(r.days) ? { version: r.version, days: r.days as number } : null;
  return { termsVersion: c.termsVersion, privacyVersion: c.privacyVersion, rejoinRetention, agreedAt: c.agreedAt };
}
