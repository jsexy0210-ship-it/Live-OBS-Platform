import type { Prisma, PrismaClient } from "@prisma/client";
import { REJOIN_RETENTION_CONSENT_VERSION } from "./rejoin";

// 구매자 가입 필수 동의(PRODUCT_SCOPE 「동의 순서」, 2026-10-03): 휴대폰 본인확인을 요청하기 전에 받는다.
// 본인확인 시작 요청이 동의 값과 화면에 보여 준 문서 버전을 보내고, 서버는 지금 버전과 같을 때만 시작한다.
// 동의 기록은 본인확인 요청(IdentityVerification.signupConsent)에 묶고, 가입을 마치면 회원(BuyerMember.signupConsent)으로 옮긴다.
// 문서(docs/terms/*_TEMPLATE.md)가 바뀌면 버전을 올린다.
export const SIGNUP_CONSENT_VERSIONS = {
  terms: "2026-10-03.v1", // 이용약관(BUYER_TERMS_TEMPLATE)
  privacy: "2026-10-03.v1", // 개인정보 수집·이용(PRIVACY_CONSENT_TEMPLATE)
  rejoinRetention: REJOIN_RETENTION_CONSENT_VERSION, // 재가입 제한 정보 보관(같은 문서 하단, 재가입 제한을 켠 쇼핑몰만)
  marketing: "2026-10-03.v1", // 마케팅 정보 수신(MARKETING_CONSENT_TEMPLATE, 선택)
} as const;

// 쇼핑몰별 약관 연결: 쇼핑몰이 이용약관·개인정보 처리방침(ShopLegalDoc)을 게시했으면 그 문서가 동의 대상이고(버전 「shop.{n}」),
// 게시 전이면 지금처럼 플랫폼 서식 버전이 동의 대상이다. 게시 판단은 파트너스·법률 검토 뒤라 여기서는 연결만 한다.
export type ShopDocRef = { kind: "TERMS" | "PRIVACY"; version: number; effectiveOn: string | null };
export type ConsentDocs = {
  terms: { version: string; shop: ShopDocRef | null };
  privacy: { version: string; shop: ShopDocRef | null };
};
export const PLATFORM_CONSENT_DOCS: ConsentDocs = {
  terms: { version: SIGNUP_CONSENT_VERSIONS.terms, shop: null },
  privacy: { version: SIGNUP_CONSENT_VERSIONS.privacy, shop: null },
};
export const shopDocVersion = (n: number) => `shop.${n}`;
// 이 쇼핑몰의 지금 동의 대상 문서. 해당 쇼핑몰의 게시본만 본다(다른 쇼핑몰 문서는 읽지 않는다).
export async function currentConsentDocs(db: Pick<PrismaClient, "shopLegalDoc">, sellerId: string): Promise<ConsentDocs> {
  const rows = await db.shopLegalDoc.findMany({ where: { sellerId, isPublished: true }, select: { kind: true, version: true, effectiveOn: true } });
  const pick = (kind: "TERMS" | "PRIVACY", platform: string) => {
    const r = rows.find((x) => x.kind === kind);
    if (!r) return { version: platform, shop: null };
    return { version: shopDocVersion(r.version), shop: { kind, version: r.version, effectiveOn: r.effectiveOn ? r.effectiveOn.toISOString().slice(0, 10) : null } };
  };
  return { terms: pick("TERMS", SIGNUP_CONSENT_VERSIONS.terms), privacy: pick("PRIVACY", SIGNUP_CONSENT_VERSIONS.privacy) };
}

export type SignupConsent = {
  termsVersion: string;
  privacyVersion: string;
  // 동의한 문서가 쇼핑몰 게시본이면 그 문서(kind·version·effectiveOn). 플랫폼 서식이거나 이 기능 전 기록이면 없다.
  shopDocs?: { terms?: ShopDocRef; privacy?: ShopDocRef };
  // 재가입 제한을 켠 쇼핑몰에서만: 동의한 문서 버전과 그때 안내한 기간(일)
  rejoinRetention: { version: string; days: number } | null;
  // 마케팅 정보 수신(선택)에 동의한 경우만: 동의한 문서 버전
  marketing: { version: string } | null;
  agreedAt: string;
};

export type ConsentFailure = "terms_required" | "invalid_rejoin_consent" | "invalid_marketing_consent" | "rejoin_policy_changed" | "consent_outdated";

// 본문: { agreedTerms: true, agreedPrivacy: true, termsVersion, privacyVersion, agreedRejoinRetention?, rejoinRetentionVersion?, rejoinRestrictionDaysShown?, agreedMarketing?, marketingVersion? }.
// rejoinDays: 지금 재가입 제한 기간(꺼져 있으면 null). 꺼진 쇼핑몰은 보관 동의 값을 보지 않는다.
// 재가입 제한 정보 보관 동의는 선택(대표님 결정 2026-10-03): 빠지거나 false면 동의 안 함(가입은 되고 기간 스냅숏 없음), 불리언이 아니면 거부.
// 동의한 경우만 화면이 보여 준 문서 버전·기간이 지금과 같아야 한다(다르면 동의한 내용을 확인할 수 없어 시작하지 않는다).
export function parseSignupConsent(raw: unknown, rejoinDays: number | null, now: Date, docs: ConsentDocs = PLATFORM_CONSENT_DOCS): { ok: true; consent: SignupConsent } | { ok: false; reason: ConsentFailure } {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (b.agreedTerms !== true || b.agreedPrivacy !== true) return { ok: false, reason: "terms_required" };
  if (b.termsVersion !== docs.terms.version || b.privacyVersion !== docs.privacy.version) return { ok: false, reason: "consent_outdated" };
  if (b.agreedRejoinRetention !== undefined && typeof b.agreedRejoinRetention !== "boolean") return { ok: false, reason: "invalid_rejoin_consent" };
  const rejoin = rejoinDays !== null && b.agreedRejoinRetention === true;
  if (rejoin && b.rejoinRetentionVersion !== SIGNUP_CONSENT_VERSIONS.rejoinRetention) return { ok: false, reason: "consent_outdated" };
  if (rejoin && b.rejoinRestrictionDaysShown !== rejoinDays) return { ok: false, reason: "rejoin_policy_changed" };
  // 마케팅 정보 수신 동의(선택)도 본인확인 전에 받는다(PRODUCT_SCOPE 「동의 순서」). 빠지거나 false면 동의 안 함, 불리언이 아니면 거부,
  // 동의한 경우 화면이 보여 준 문서 버전이 지금과 같아야 한다.
  if (b.agreedMarketing !== undefined && typeof b.agreedMarketing !== "boolean") return { ok: false, reason: "invalid_marketing_consent" };
  const marketing = b.agreedMarketing === true;
  if (marketing && b.marketingVersion !== SIGNUP_CONSENT_VERSIONS.marketing) return { ok: false, reason: "consent_outdated" };
  return {
    ok: true,
    consent: {
      termsVersion: docs.terms.version,
      privacyVersion: docs.privacy.version,
      ...(docs.terms.shop || docs.privacy.shop ? { shopDocs: { ...(docs.terms.shop ? { terms: docs.terms.shop } : {}), ...(docs.privacy.shop ? { privacy: docs.privacy.shop } : {}) } } : {}),
      rejoinRetention: rejoin && rejoinDays !== null ? { version: SIGNUP_CONSENT_VERSIONS.rejoinRetention, days: rejoinDays } : null,
      marketing: marketing ? { version: SIGNUP_CONSENT_VERSIONS.marketing } : null,
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
  const m = c.marketing as Record<string, unknown> | null | undefined;
  const marketing = m && typeof m.version === "string" ? { version: m.version } : null;
  const sd = c.shopDocs as Record<string, unknown> | null | undefined;
  const ref = (v: unknown, kind: "TERMS" | "PRIVACY"): ShopDocRef | undefined => {
    const r = v as Record<string, unknown> | null | undefined;
    return r && r.kind === kind && Number.isInteger(r.version) ? { kind, version: r.version as number, effectiveOn: typeof r.effectiveOn === "string" ? r.effectiveOn : null } : undefined;
  };
  const terms = sd ? ref(sd.terms, "TERMS") : undefined;
  const privacy = sd ? ref(sd.privacy, "PRIVACY") : undefined;
  return { termsVersion: c.termsVersion, privacyVersion: c.privacyVersion, ...(terms || privacy ? { shopDocs: { ...(terms ? { terms } : {}), ...(privacy ? { privacy } : {}) } } : {}), rejoinRetention, marketing, agreedAt: c.agreedAt };
}

// 재동의 필요 여부(표시용 플래그, 강제 재동의 흐름은 없다): 회원이 동의한 문서 버전이 지금 이 쇼핑몰의 동의 대상 버전과 다르면 true.
// 동의 기록이 없는 회원(이 기능 전 가입)은 비교할 수 없어 recorded: false·false로 둔다.
export function consentStatus(docs: ConsentDocs, consent: SignupConsent | null) {
  if (!consent) return { recorded: false as const, termsOutdated: false, privacyOutdated: false, reconsentRequired: false };
  const termsOutdated = consent.termsVersion !== docs.terms.version;
  const privacyOutdated = consent.privacyVersion !== docs.privacy.version;
  return { recorded: true as const, termsOutdated, privacyOutdated, reconsentRequired: termsOutdated || privacyOutdated };
}
