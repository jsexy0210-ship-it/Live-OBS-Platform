import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as legalConsentGet } from "../../app/api/shop/[slug]/me/legal-consent/route";
import { POST as loginRoute } from "../../app/api/shop/[slug]/auth/login/route";
import { POST as signupRoute } from "../../app/api/shop/[slug]/signup/route";
import { POST as confirmRoute } from "../../app/api/shop/[slug]/signup/verification/confirm/route";
import { POST as startRoute } from "../../app/api/shop/[slug]/signup/verification/route";
import { SIGNUP_CONSENT_VERSIONS, consentStatus, currentConsentDocs, parseSignupConsent, PLATFORM_CONSENT_DOCS, readSignupConsent } from "../../lib/server/buyers/consent";
import { prisma } from "../../lib/server/db";
import { IDV_INPUT, createSeller, db, resetDb } from "./helpers";

// 쇼핑몰별 약관 동의 버전 연결: 쇼핑몰이 게시한 이용약관·개인정보 처리방침이 동의 대상(버전 shop.{n}), 게시 전이면 플랫폼 서식 버전.
// 가입 기록에 문서 kind·version·effectiveOn 저장, 기존 기록 호환, 쇼핑몰 격리, 버전이 바뀐 뒤 재동의 필요 여부는 표시용 플래그만.
beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const post = (url: string, body: unknown, cookie?: string) => new Request(`http://localhost:3000${url}`, { method: "POST", headers: { ...H, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0];
const NOW = new Date("2026-10-05T00:00:00Z");

async function publish(sellerId: string, kind: "TERMS" | "PRIVACY", version: number, effectiveOn: string | null = "2026-11-01", isPublished = true) {
  return db.shopLegalDoc.upsert({
    where: { sellerId_kind: { sellerId, kind } },
    update: { body: "본문", version, effectiveOn: effectiveOn ? new Date(effectiveOn) : null, isPublished },
    create: { sellerId, kind, body: "본문", version, effectiveOn: effectiveOn ? new Date(effectiveOn) : null, isPublished },
  });
}
const input = (docs: { terms: string; privacy: string }) => ({ agreedTerms: true, agreedPrivacy: true, termsVersion: docs.terms, privacyVersion: docs.privacy });

describe("동의 대상 문서 currentConsentDocs", () => {
  it("게시 전·미게시·임시 저장이면 플랫폼 서식 버전, 게시하면 shop.{n}과 문서 정보. 다른 쇼핑몰 문서는 보지 않는다", async () => {
    const a = (await createSeller()).seller;
    const b = (await createSeller()).seller;
    expect(await currentConsentDocs(db, a.id)).toEqual(PLATFORM_CONSENT_DOCS);
    await publish(a.id, "TERMS", 2, "2026-11-01", false);
    expect(await currentConsentDocs(db, a.id)).toEqual(PLATFORM_CONSENT_DOCS);
    await publish(a.id, "TERMS", 3);
    await publish(b.id, "PRIVACY", 9, "2027-01-01");
    expect(await currentConsentDocs(db, a.id)).toEqual({
      terms: { version: "shop.3", shop: { kind: "TERMS", version: 3, effectiveOn: "2026-11-01" } },
      privacy: { version: SIGNUP_CONSENT_VERSIONS.privacy, shop: null },
    });
    expect((await currentConsentDocs(db, b.id)).privacy).toEqual({ version: "shop.9", shop: { kind: "PRIVACY", version: 9, effectiveOn: "2027-01-01" } });
  });
});

describe("동의 검사·기록 parseSignupConsent", () => {
  it("게시본이 있으면 shop 버전만 맞고(플랫폼 버전은 consent_outdated), 기록에 문서 kind·version·effectiveOn이 남는다", async () => {
    const a = (await createSeller()).seller;
    await publish(a.id, "TERMS", 3);
    await publish(a.id, "PRIVACY", 1, null);
    const docs = await currentConsentDocs(db, a.id);
    expect(parseSignupConsent(input({ terms: SIGNUP_CONSENT_VERSIONS.terms, privacy: SIGNUP_CONSENT_VERSIONS.privacy }), null, NOW, docs)).toEqual({ ok: false, reason: "consent_outdated" });
    const r = parseSignupConsent(input({ terms: "shop.3", privacy: "shop.1" }), null, NOW, docs);
    expect(r.ok && r.consent).toMatchObject({
      termsVersion: "shop.3",
      privacyVersion: "shop.1",
      shopDocs: { terms: { kind: "TERMS", version: 3, effectiveOn: "2026-11-01" }, privacy: { kind: "PRIVACY", version: 1, effectiveOn: null } },
    });
    // 읽어 올 때도 같은 모양
    expect(readSignupConsent(JSON.parse(JSON.stringify(r.ok && r.consent)))).toMatchObject({ shopDocs: { terms: { version: 3 } } });
  });
  it("게시본이 없으면 지금처럼 플랫폼 버전만 맞고 shopDocs는 기록하지 않는다(기존 기록 모양 그대로)", () => {
    const r = parseSignupConsent(input({ terms: SIGNUP_CONSENT_VERSIONS.terms, privacy: SIGNUP_CONSENT_VERSIONS.privacy }), null, NOW);
    expect(r.ok && "shopDocs" in r.consent).toBe(false);
    expect(parseSignupConsent(input({ terms: "shop.1", privacy: SIGNUP_CONSENT_VERSIONS.privacy }), null, NOW)).toEqual({ ok: false, reason: "consent_outdated" });
  });
  it("shopDocs가 없는 예전 기록도 읽힌다", () => {
    const old = { termsVersion: "2026-10-03.v1", privacyVersion: "2026-10-03.v1", rejoinRetention: null, marketing: null, agreedAt: NOW.toISOString() };
    expect(readSignupConsent(old)).toEqual(old);
  });
});

describe("재동의 필요 여부 consentStatus(표시용 플래그)", () => {
  it("버전이 같으면 false, 쇼핑몰이 약관을 게시·수정하면 해당 항목만 true, 기록 없는 회원은 recorded: false", async () => {
    const a = (await createSeller()).seller;
    const consent = (parseSignupConsent(input({ terms: SIGNUP_CONSENT_VERSIONS.terms, privacy: SIGNUP_CONSENT_VERSIONS.privacy }), null, NOW) as { ok: true; consent: ReturnType<typeof readSignupConsent> & object }).consent;
    expect(consentStatus(await currentConsentDocs(db, a.id), consent)).toEqual({ recorded: true, termsOutdated: false, privacyOutdated: false, reconsentRequired: false });
    await publish(a.id, "TERMS", 1);
    expect(consentStatus(await currentConsentDocs(db, a.id), consent)).toEqual({ recorded: true, termsOutdated: true, privacyOutdated: false, reconsentRequired: true });
    expect(consentStatus(await currentConsentDocs(db, a.id), null)).toEqual({ recorded: false, termsOutdated: false, privacyOutdated: false, reconsentRequired: false });
  });
});

describe("가입 HTTP와 내 동의 조회 GET /api/shop/{slug}/me/legal-consent", () => {
  async function signupAndLogin(slug: string, docs: { terms: string; privacy: string }) {
    const base = `/api/shop/${slug}/signup`;
    const s = await startRoute(post(`${base}/verification`, { ...IDV_INPUT, ...input(docs) }), ctx(slug));
    if (s.status !== 200) return { status: s.status, body: await s.json() };
    const cookie = cookieOf(s, "lo_bidv");
    const { verificationId } = await s.json();
    expect((await confirmRoute(post(`${base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(slug))).status).toBe(200);
    const r = await signupRoute(post(base, { verificationId, loginId: "buyer01@example.com", password: "pw-123456", broadcastNickname: "카드왕", agreedTerms: true, agreedPrivacy: true }, cookie), ctx(slug));
    expect(r.status).toBe(201);
    const login = await loginRoute(post(`/api/shop/${slug}/auth/login`, { loginId: "buyer01@example.com", password: "pw-123456" }), ctx(slug));
    expect(login.status).toBe(200);
    const buyerCookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0];
    return { status: 200, verificationId, buyerCookie };
  }
  const me = async (slug: string, cookie: string) => {
    const r = await legalConsentGet(new Request(`http://localhost:3000/api/shop/${slug}/me/legal-consent`, { headers: { host: "localhost:3000", cookie } }), ctx(slug));
    return { status: r.status, body: await r.json() };
  };

  it("약관을 게시한 쇼핑몰: 옛 플랫폼 버전으로는 시작이 409, shop 버전으로 가입하면 가입 기록에 문서 정보가 남고 내 동의 조회가 일치(재동의 불필요). 약관을 수정하면 재동의 필요 플래그", async () => {
    const a = (await createSeller()).seller;
    await publish(a.id, "TERMS", 3);
    await publish(a.id, "PRIVACY", 1);
    const stale = await signupAndLogin(a.slug, { terms: SIGNUP_CONSENT_VERSIONS.terms, privacy: SIGNUP_CONSENT_VERSIONS.privacy });
    expect(stale.status).toBe(409);
    const ok = await signupAndLogin(a.slug, { terms: "shop.3", privacy: "shop.1" });
    expect(ok.status).toBe(200);
    const rec = (await db.identityVerification.findUniqueOrThrow({ where: { id: ok.verificationId } })).signupConsent as { shopDocs: { terms: { version: number } } };
    expect(rec.shopDocs.terms.version).toBe(3);
    const first = await me(a.slug, ok.buyerCookie!);
    expect(first.body).toMatchObject({ recorded: true, reconsentRequired: false, agreed: { termsVersion: "shop.3", shopDocs: { terms: { kind: "TERMS", version: 3, effectiveOn: "2026-11-01" } } }, current: { terms: { version: "shop.3" } } });
    await publish(a.id, "TERMS", 4);
    expect((await me(a.slug, ok.buyerCookie!)).body).toMatchObject({ termsOutdated: true, privacyOutdated: false, reconsentRequired: true });
  });

  it("약관을 게시하지 않은 쇼핑몰은 지금처럼 플랫폼 버전으로 가입하고, 다른 쇼핑몰의 게시는 영향을 주지 않는다. 로그인 없이는 401", async () => {
    const a = (await createSeller()).seller;
    const other = (await createSeller()).seller;
    await publish(other.id, "TERMS", 7);
    const ok = await signupAndLogin(a.slug, { terms: SIGNUP_CONSENT_VERSIONS.terms, privacy: SIGNUP_CONSENT_VERSIONS.privacy });
    expect(ok.status).toBe(200);
    const r = await me(a.slug, ok.buyerCookie!);
    expect(r.body).toMatchObject({ recorded: true, reconsentRequired: false, agreed: { termsVersion: SIGNUP_CONSENT_VERSIONS.terms, shopDocs: null } });
    expect(r.body.current.terms.shop).toBeNull();
    expect((await me(a.slug, "")).status).toBe(401);
    // 다른 쇼핑몰 주소로는 이 회원 세션이 통하지 않는다
    expect((await me(other.slug, ok.buyerCookie!)).status).toBe(401);
  });
});
