import { Prisma, type PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as loginRoute } from "../../app/api/shop/[slug]/auth/login/route";
import { POST as signupRoute } from "../../app/api/shop/[slug]/signup/route";
import { POST as confirmRoute } from "../../app/api/shop/[slug]/signup/verification/confirm/route";
import { POST as resendRoute } from "../../app/api/shop/[slug]/signup/verification/resend/route";
import { POST as startRoute } from "../../app/api/shop/[slug]/signup/verification/route";
import { BUYER_SIGNUP_MESSAGES, BUYER_SIGNUP_STATUS, BUYER_SIGNUP_VERIFY_DAILY_LIMIT_PER_IP, MAX_SIGNUP_ATTEMPTS_PER_VERIFICATION, purgeOldSignupVerificationIps, purgeUnfinishedSignupVerifications, signupBuyer, startBuyerSignupVerification } from "../../lib/server/buyers/signup";
import { prisma } from "../../lib/server/db";
import { startSellerPasswordReset } from "../../lib/server/auth/passwordReset";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { identityProvider } from "../../lib/server/identity/registry";
import { buyerSignupIdentityLimitReached, identityUsage, resendIdentityCode } from "../../lib/server/identity/verification";
import { startSellerSignupVerification } from "../../lib/server/sellers/application";
import { IDV_INPUT, SIGNUP_CONSENT, confirmIdv, createSeller, db, failingAudit, resetDb, startIdv } from "./helpers";

beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const post = (url: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost:3000${url}`, { method: "POST", headers: { ...H, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
// 가입 요청에는 User-Agent를 붙여 감사 로그에 남는지 본다
const withAgent = (url: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost:3000${url}`, {
    method: "POST",
    headers: { ...H, "user-agent": "signup-test-agent", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0];

async function shop() {
  const { seller } = await createSeller();
  const slug = seller.slug;
  const base = `/api/shop/${slug}/signup`;
  // 본인확인 시작 → 인증번호 확인까지 마친 브라우저(쿠키)와 요청 id
  const verified = async (person: Partial<Record<keyof typeof IDV_INPUT, string>> = {}) => {
    const s = await startRoute(post(`${base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, ...person }), ctx(slug));
    expect(s.status).toBe(200);
    const cookie = cookieOf(s, "lo_bidv");
    const { verificationId } = await s.json();
    const c = await confirmRoute(post(`${base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(slug));
    expect(c.status).toBe(200);
    return { cookie, verificationId };
  };
  const signup = (v: { cookie?: string; verificationId: string }, body: Record<string, unknown> = {}) =>
    signupRoute(
      withAgent(base, { verificationId: v.verificationId, loginId: "buyer01@example.com", password: "pw-123456", broadcastNickname: "카드왕", agreedTerms: true, agreedPrivacy: true, ...body }, v.cookie),
      ctx(slug),
    );
  return { seller, slug, base, verified, signup };
}

describe("구매자 가입 HTTP", () => {
  it("동의 순서: 본인확인 시작은 필수 동의와 지금 문서 버전이 있어야 하고(없으면 400·다르면 409, 기록·문자 없음), 받은 동의를 본인확인에 묶었다가 가입하면 회원으로 옮긴다", async () => {
    const s = await shop();
    const fake = identityProvider() as FakeIdentityProvider;
    const sentBefore = fake.sent.length;
    const start = (body: Record<string, unknown>) => startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...body }), ctx(s.slug));
    for (const [body, code, status] of [
      [{}, "terms_required", 400],
      [{ ...SIGNUP_CONSENT, agreedTerms: false }, "terms_required", 400],
      [{ ...SIGNUP_CONSENT, agreedPrivacy: "true" }, "terms_required", 400],
      [{ ...SIGNUP_CONSENT, termsVersion: "2020-01-01.v0" }, "consent_outdated", 409],
      [{ ...SIGNUP_CONSENT, privacyVersion: undefined }, "consent_outdated", 409],
    ] as const) {
      const r = await start(body);
      expect(r.status, JSON.stringify(body)).toBe(status);
      expect(await r.json()).toEqual({ error: code, message: BUYER_SIGNUP_MESSAGES[code] });
    }
    expect(await db.identityVerification.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect(fake.sent.length).toBe(sentBefore);

    const v = await s.verified();
    const consent = (await db.identityVerification.findUniqueOrThrow({ where: { id: v.verificationId } })).signupConsent;
    expect(consent).toEqual({ termsVersion: SIGNUP_CONSENT.termsVersion, privacyVersion: SIGNUP_CONSENT.privacyVersion, rejoinRetention: null, agreedAt: expect.any(String) });
    // 가입 본문에 약관 값이 없어도 본인확인 때 받은 동의로 가입된다
    const r = await signupRoute(post(s.base, { verificationId: v.verificationId, loginId: "c@example.com", password: "pw-123456", broadcastNickname: "동의" }, v.cookie), ctx(s.slug));
    expect(r.status).toBe(201);
    const m = await db.buyerMember.findFirstOrThrow({ where: { sellerId: s.seller.id } });
    expect(m.signupConsent).toEqual(consent);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.signup", actorId: m.id } })).toMatchObject({
      after: { agreedTerms: true, agreedPrivacy: true, termsVersion: SIGNUP_CONSENT.termsVersion, privacyVersion: SIGNUP_CONSENT.privacyVersion, consentAgreedAt: (consent as { agreedAt: string }).agreedAt },
    });
  });

  it("동의 기록이 없는 본인확인(이 변경 전 요청)으로는 가입할 수 없고 처음부터 다시 하게 한다", async () => {
    const s = await shop();
    const v = await s.verified();
    await db.identityVerification.update({ where: { id: v.verificationId }, data: { signupConsent: Prisma.DbNull } });
    const r = await s.signup(v);
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe("verification_invalid");
  });

  it("가입을 마친 본인확인의 요청 IP는 3개월이 지나면 비우고, 가입 처리 때 그 쇼핑몰 것을 함께 정리한다(다른 쇼핑몰·3개월 안은 그대로)", async () => {
    const s = await shop();
    const other = await shop();
    const ago = (months: number) => {
      const d = new Date();
      d.setUTCMonth(d.getUTCMonth() - months);
      return d;
    };
    const made = async (sh: typeof s, phone: string, name: string, months: number) => {
      const v = await sh.verified({ phone, name });
      expect((await sh.signup(v, { loginId: `${phone}@example.com`, broadcastNickname: name })).status).toBe(201);
      await db.identityVerification.update({ where: { id: v.verificationId }, data: { requestIp: "203.0.113.9", createdAt: ago(months) } });
      return v.verificationId;
    };
    const old = await made(s, "01011110001", "오래됨", 4);
    const recent = await made(s, "01011110002", "최근", 2);
    const otherOld = await made(other, "01011110003", "다른곳", 4);
    // 같은 쇼핑몰에서 새 가입 요청이 오면 그 쇼핑몰의 3개월 지난 IP만 비운다
    const v = await s.verified({ phone: "01011110004", name: "새가입" });
    expect((await s.signup(v, { loginId: "new@example.com", broadcastNickname: "새가입" })).status).toBe(201);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: old } })).requestIp).toBeNull();
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: recent } })).requestIp).toBe("203.0.113.9");
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: otherOld } })).requestIp).toBe("203.0.113.9");
    // 쇼핑몰을 정하지 않으면 전체
    expect(await purgeOldSignupVerificationIps(db)).toBe(1);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: otherOld } })).requestIp).toBeNull();
  });

  it("가입을 끝내지 않은 본인확인은 유효 시간이 지나면 행을 지우지 않고 식별 항목만 비우며(requestId 무작위), 상태·쇼핑몰·요청 시각·요청 IP는 남겨 같은 IP 하루 횟수와 체험 한도를 그대로 센다", async () => {
    const s = await shop();
    const used = await s.verified({ phone: "01010101010", name: "가입함" });
    expect((await s.signup(used, { loginId: "used@example.com", broadcastNickname: "가입함" })).status).toBe(201);
    const stale = await s.verified({ phone: "01020202020", name: "안함" });
    const fresh = await s.verified({ phone: "01030303030", name: "진행중" });
    const pendingStart = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, phone: "01040404040", name: "확인전" }), ctx(s.slug));
    const pending = (await pendingStart.json()).verificationId as string;
    const now = new Date();
    for (const id of [stale.verificationId, pending]) await db.identityVerification.update({ where: { id }, data: { expiresAt: new Date(now.getTime() - 1000), subjectId: crypto.randomUUID() } });
    const before = new Map((await db.identityVerification.findMany()).map((r) => [r.id, r]));
    const usage = await identityUsage(db, s.seller.id);
    expect(usage).toBe(3);

    expect(await purgeUnfinishedSignupVerifications(db, now)).toBe(2);
    for (const id of [stale.verificationId, pending]) {
      const r = await db.identityVerification.findUniqueOrThrow({ where: { id } });
      const was = before.get(id)!;
      expect(r).toMatchObject({
        name: null, phone: null, birthDate: null, ciHash: null, requestedPhone: null, subjectId: null, signupConsent: null, ownerTokenHash: null,
        anonymizedAt: now, status: was.status, sellerId: was.sellerId, createdAt: was.createdAt, requestIp: was.requestIp,
      });
      expect(r.requestId).not.toBe(was.requestId);
      expect(r.requestId).toMatch(/^anonymized:/);
    }
    // 비식별한 확인 완료 기록(CI 해시 없음)도 CHECK를 지키며 남고, 체험 한도 사용량은 그대로
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: stale.verificationId } })).status).toBe("VERIFIED");
    expect(await identityUsage(db, s.seller.id)).toBe(usage);
    expect(await db.identityVerification.findUniqueOrThrow({ where: { id: fresh.verificationId } })).toMatchObject({ status: "VERIFIED", name: "진행중", anonymizedAt: null });
    expect(await db.identityVerification.findUniqueOrThrow({ where: { id: used.verificationId } })).toMatchObject({ consumedAt: expect.any(Date), name: "가입함", anonymizedAt: null });
    // 다시 돌려도 같은 결과(멱등)
    expect(await purgeUnfinishedSignupVerifications(db, now)).toBe(0);
    // 같은 IP 하루 횟수도 정리 전과 같이 센다: 이미 4건이라 6건만 더 시작되고 다음은 429
    for (let i = 0; i < BUYER_SIGNUP_VERIFY_DAILY_LIMIT_PER_IP - 4; i++) {
      expect((await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, phone: `0105555${String(i).padStart(4, "0")}` }), ctx(s.slug))).status).toBe(200);
    }
    expect((await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, phone: "01066660000" }), ctx(s.slug))).status).toBe(429);
  });

  it("체험 한도가 찬 쇼핑몰은 확인 완료 기록을 비식별해도 한도가 다시 생기지 않는다", async () => {
    const s = await shop();
    await db.subscriptionPlan.upsert({
      where: { code: "STANDARD" },
      update: { trialIdentityLimit: 1 },
      create: { code: "STANDARD", name: "스탠다드", listPrice: 300000, salePrice: 199000, trialIdentityLimit: 1 },
    });
    const v = await s.verified();
    await db.identityVerification.update({ where: { id: v.verificationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await purgeUnfinishedSignupVerifications(db)).toBe(1);
    const again = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, phone: "01077778888" }), ctx(s.slug));
    expect(again.status).toBe(403);
    expect((await again.json()).error).toBe("trial_limit_exceeded");
  });

  it("본인확인 시작 → 인증번호 확인 → 가입하면 201로 바로 로그인되고, 이름·휴대폰은 본인확인 결과를 쓰며 동의를 기록한다", async () => {
    const s = await shop();
    const start = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(s.slug));
    const flow = start.headers.getSetCookie().find((c) => c.startsWith("lo_bidv="))!;
    expect(flow).toContain(`Path=/api/shop/${s.slug}/signup`);
    expect(flow).toContain("HttpOnly");
    const v = await s.verified({ name: "김구매", phone: "01099998888" });
    const res = await s.signup(v);
    expect(res.status).toBe(201);
    expect(cookieOf(res, "lo_buyer")).toMatch(/^lo_buyer=.+/);
    // 응답 본문이 끊겨도 같은 요청을 다시 보낼 수 있게 본인확인 쿠키는 지우지 않는다(본인확인은 소진되어 재전송에만 쓰임)
    expect(res.headers.getSetCookie().some((c) => c.startsWith("lo_bidv="))).toBe(false);
    const member = await db.buyerMember.findFirstOrThrow({ where: { sellerId: s.seller.id } });
    expect(member).toMatchObject({ loginId: "buyer01@example.com", name: "김구매", phone: "01099998888", broadcastNickname: "카드왕" });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.signup", actorId: member.id } })).toMatchObject({
      userAgent: "signup-test-agent",
      after: { agreedTerms: true, agreedPrivacy: true },
    });
    // 로그인도 이메일 대소문자를 가리지 않는다
    const login = await loginRoute(post(`/api/shop/${s.slug}/auth/login`, { loginId: "Buyer01@Example.COM", password: "pw-123456" }), ctx(s.slug));
    expect(login.status).toBe(200);
  });

  it("마케팅 수신 동의(선택): true면 동의 시각을 남기고, false·빠짐이면 남기지 않으며, 감사 로그에 동의 여부를 기록한다", async () => {
    for (const [i, [body, agreed]] of ([
      [{ agreedMarketing: true }, true],
      [{ agreedMarketing: false }, false],
      [{}, false],
    ] as const).entries()) {
      const s = await shop();
      const v = await s.verified({ phone: `0109999000${i}` });
      const res = await s.signup(v, body);
      expect(res.status, JSON.stringify(body)).toBe(201);
      const member = await db.buyerMember.findFirstOrThrow({ where: { sellerId: s.seller.id } });
      expect(member.marketingConsentAt === null, JSON.stringify(body)).toBe(!agreed);
      if (agreed) expect(member.marketingConsentAt).toEqual(member.createdAt);
      expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.signup", actorId: member.id } })).toMatchObject({
        after: { agreedTerms: true, agreedPrivacy: true, agreedMarketing: agreed },
      });
    }
  });

  it("마케팅 수신 동의 값이 불리언이 아니면 400과 문구를 주고 가입·본인확인을 쓰지 않는다", async () => {
    const s = await shop();
    const v = await s.verified();
    for (const value of ["true", 1, null]) {
      const r = await s.signup(v, { agreedMarketing: value });
      expect(r.status, JSON.stringify(value)).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_marketing_consent", message: BUYER_SIGNUP_MESSAGES.invalid_marketing_consent });
    }
    expect(await db.buyerMember.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: v.verificationId } })).consumedAt).toBeNull();
  });

  it("입력이 틀리면 400과 문구를 주고 본인확인을 쓰지 않는다(고친 뒤 같은 본인확인으로 가입할 수 있다)", async () => {
    const s = await shop();
    const v = await s.verified();
    for (const [body, code] of [
      [{ loginId: "buyer01" }, "invalid_login_id"],
      [{ loginId: "buyer@nodot" }, "invalid_login_id"],
      [{ loginId: "a b@example.com" }, "invalid_login_id"],
      [{ loginId: `${"a".repeat(250)}@example.com` }, "invalid_login_id"],
      [{ password: "short" }, "weak_password"],
      [{ broadcastNickname: "​" }, "invalid_nickname"],
      [{ broadcastNickname: "닉".repeat(21) }, "invalid_nickname"],
    ] as const) {
      const r = await s.signup(v, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toEqual({ error: code, message: BUYER_SIGNUP_MESSAGES[code] });
    }
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: v.verificationId } })).consumedAt).toBeNull();
    expect((await s.signup(v)).status).toBe(201);
  });

  it("254자 이메일은 가입·로그인 모두 되고, 255자는 가입 400(invalid_login_id)·로그인 400", async () => {
    const s = await shop();
    const email = (len: number) => `${"a".repeat(64)}@${"b".repeat(len - 64 - 1 - 5)}.test`;
    expect(email(254)).toHaveLength(254);
    const tooLong = await s.signup(await s.verified(), { loginId: email(255) });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toBe("invalid_login_id");
    const ok = await s.signup(await s.verified(), { loginId: email(254) });
    expect(ok.status).toBe(201);
    const login = (loginId: string) => loginRoute(post(`/api/shop/${s.slug}/auth/login`, { loginId, password: "pw-123456" }), ctx(s.slug));
    expect((await login(email(254).toUpperCase())).status).toBe(200);
    expect((await login(email(255))).status).toBe(400);
  });

  it("아이디에 NUL 같은 제어문자가 있으면 가입·로그인 모두 500이 아니라 400", async () => {
    const s = await shop();
    const v = await s.verified();
    for (const loginId of ["x\u0000@example.com", "x@exa\u0007mple.com", "x\u200b@example.com"]) {
      const r = await s.signup(v, { loginId });
      expect(r.status, JSON.stringify(loginId)).toBe(400);
      expect((await r.json()).error).toBe("invalid_login_id");
      const login = await loginRoute(post(`/api/shop/${s.slug}/auth/login`, { loginId, password: "pw-123456" }), ctx(s.slug));
      expect(login.status, JSON.stringify(loginId)).toBe(400);
    }
  });

  it("본인확인을 마치지 않았거나, 시작한 브라우저가 아니거나, 이미 쓴 본인확인이면 가입할 수 없다", async () => {
    const s = await shop();
    const start = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(s.slug));
    const pending = { cookie: cookieOf(start, "lo_bidv"), verificationId: (await start.json()).verificationId };
    const r1 = await s.signup(pending);
    expect(r1.status).toBe(409);
    expect((await r1.json()).error).toBe("verification_pending");
    const v = await s.verified({ name: "다른사람", birth7: "9001011" });
    expect((await s.signup({ verificationId: v.verificationId })).status).toBe(400);
    expect((await s.signup({ verificationId: v.verificationId, cookie: "lo_bidv=someone-else" })).status).toBe(400);
    expect((await s.signup({ verificationId: "not-a-uuid", cookie: v.cookie })).status).toBe(400);
    expect((await s.signup(v, { loginId: "first01@example.com" })).status).toBe(201);
    const again = await s.signup(v, { loginId: "second01@example.com", broadcastNickname: "다른닉" });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("verification_invalid");
  });

  it("같은 사람(CI)은 같은 쇼핑몰에 한 번만, 아이디·방송 닉네임이 겹치면 409와 문구", async () => {
    const s = await shop();
    expect((await s.signup(await s.verified())).status).toBe(201);
    const dup = await s.signup(await s.verified(), { loginId: "other01@example.com", broadcastNickname: "다른닉" });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "already_member", message: BUYER_SIGNUP_MESSAGES.already_member });
    // 대소문자만 다른 이메일도 같은 아이디로 본다(소문자로 맞춰 저장)
    const idTaken = await s.signup(await s.verified({ name: "이몽룡", phone: "01011112222" }), { loginId: " BUYER01@example.com ", broadcastNickname: "새닉" });
    expect(idTaken.status).toBe(409);
    expect((await idTaken.json()).error).toBe("login_id_taken");
    const nickTaken = await s.signup(await s.verified({ name: "성춘향", phone: "01033334444" }), { loginId: "new01@example.com" });
    expect(nickTaken.status).toBe(409);
    expect((await nickTaken.json()).error).toBe("nickname_taken");
  });

  it("인증번호 다시 보내기·확인은 이 쇼핑몰 가입 경로의 쿠키로만, 다른 브라우저의 요청 id는 404", async () => {
    const s = await shop();
    const start = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(s.slug));
    const cookie = cookieOf(start, "lo_bidv");
    const { verificationId } = await start.json();
    expect((await resendRoute(post(`${s.base}/verification/resend`, { verificationId }, cookie), ctx(s.slug))).status).toBe(429);
    expect((await confirmRoute(post(`${s.base}/verification/confirm`, { verificationId, code: "000000" }, "lo_bidv=someone-else"), ctx(s.slug))).status).toBe(404);
    const wrong = await confirmRoute(post(`${s.base}/verification/confirm`, { verificationId, code: "987654" }, cookie), ctx(s.slug));
    expect(wrong.status).toBe(400);
  });

  it("없는 쇼핑몰은 404, 잠긴 쇼핑몰은 402, 인적사항이 틀리면 400, 같은 IP·같은 쇼핑몰 하루 10회를 넘으면 429", async () => {
    const s = await shop();
    expect((await startRoute(post(`/api/shop/nope/signup/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx("nope"))).status).toBe(404);
    expect((await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, carrier: "SKY" }), ctx(s.slug))).status).toBe(400);
    for (let i = 0; i < BUYER_SIGNUP_VERIFY_DAILY_LIMIT_PER_IP; i++) {
      expect((await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(s.slug))).status).toBe(200);
    }
    const limited = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(s.slug));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "daily_limit_exceeded", message: BUYER_SIGNUP_MESSAGES.daily_limit_exceeded });
    // 다른 쇼핑몰은 따로 센다
    const other = await shop();
    expect((await startRoute(post(`${other.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(other.slug))).status).toBe(200);
    // 잠긴 쇼핑몰(체험 종료·구독 없음)
    await db.seller.update({ where: { id: other.seller.id }, data: { trialEndsAt: new Date("2000-01-01T00:00:00Z") } });
    const locked = await startRoute(post(`${other.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(other.slug));
    expect(locked.status).toBe(402);
  });
});

describe("본인확인 단계·가입 시도 제한(#114 보안 검수 후속)", () => {
  it("본인확인 1건으로 가입을 5번 시도하면(중복 실패 포함) 그 뒤로는 맞는 입력이어도 429, 본인확인을 다시 하면 가입된다", async () => {
    const s = await shop();
    expect((await s.signup(await s.verified())).status).toBe(201);
    const v = await s.verified({ name: "이몽룡", phone: "01011112222" });
    for (let i = 0; i < MAX_SIGNUP_ATTEMPTS_PER_VERIFICATION; i++) {
      const r = await s.signup(v, { broadcastNickname: `닉${i}` });
      expect(r.status).toBe(409);
      expect((await r.json()).error).toBe("login_id_taken");
    }
    const blocked = await s.signup(v, { loginId: "free@example.com", broadcastNickname: "새닉" });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "too_many_signup_attempts", message: BUYER_SIGNUP_MESSAGES.too_many_signup_attempts });
    expect(await db.buyerMember.count({ where: { sellerId: s.seller.id } })).toBe(1);
    // 입력 형식 오류는 세지 않는다(DB를 보기 전에 끝남) — 새 본인확인으로 가입
    const fresh = await s.verified({ name: "이몽룡", phone: "01011112222" });
    expect((await s.signup(fresh, { loginId: "bad" })).status).toBe(400);
    expect((await s.signup(fresh, { loginId: "free@example.com", broadcastNickname: "새닉" })).status).toBe(201);
  });

  it("다시 보내기·확인은 URL 쇼핑몰이 본인확인 기록의 쇼핑몰과 같아야 하고(다르면 404), 잠긴 쇼핑몰이면 402", async () => {
    const a = await shop();
    const b = await shop();
    const start = await startRoute(post(`${a.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(a.slug));
    const cookie = cookieOf(start, "lo_bidv");
    const { verificationId } = await start.json();
    expect((await confirmRoute(post(`${b.base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(b.slug))).status).toBe(404);
    expect((await resendRoute(post(`${b.base}/verification/resend`, { verificationId }, cookie), ctx(b.slug))).status).toBe(404);
    expect((await confirmRoute(post(`/api/shop/nope/signup/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx("nope"))).status).toBe(404);
    await db.seller.update({ where: { id: a.seller.id }, data: { trialEndsAt: new Date("2000-01-01T00:00:00Z") } });
    const locked = await confirmRoute(post(`${a.base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(a.slug));
    expect(locked.status).toBe(402);
    expect((await locked.json()).error).toBe("shop_unavailable");
    expect((await resendRoute(post(`${a.base}/verification/resend`, { verificationId }, cookie), ctx(a.slug))).status).toBe(402);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: verificationId } })).status).toBe("PENDING");
  });
});

describe("signupBuyer는 completeIdentityVerification을 거친다", () => {
  it("다른 공급자로 만든 본인확인 기록으로는 가입할 수 없다(공급자 확인)", async () => {
    const provider = new FakeIdentityProvider();
    const { seller } = await createSeller();
    const { verification, ownerToken } = await startIdv(provider, { purpose: "BUYER_SIGNUP", sellerId: seller.id });
    const done = await confirmIdv(provider, verification, ownerToken);
    expect(done.ok).toBe(true);
    await db.identityVerification.update({ where: { id: verification.id }, data: { provider: "portone" } });
    expect(
      await signupBuyer(db, provider, {
        sellerId: seller.id,
        verificationId: verification.id,
        ownerToken,
        loginId: "buyer01@example.com",
        password: "pw-123456",
        broadcastNickname: "닉",
      }),
    ).toEqual({ ok: false, reason: "verification_invalid" });
    expect(await db.buyerMember.count()).toBe(0);
  });
  it("체험 중 본인확인 한도가 찼으면 시작·다시 보내기에서 문자를 보내기 전에 403 trial_limit_exceeded로 막는다", async () => {
    const s = await shop();
    await db.subscriptionPlan.upsert({
      where: { code: "STANDARD" },
      update: { trialIdentityLimit: 1 },
      create: { code: "STANDARD", name: "스탠다드", listPrice: 300000, salePrice: 199000, trialIdentityLimit: 1 },
    });
    // 한도가 차기 전에 시작해 둔 본인확인(아직 확인 전)
    const startA = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, phone: "01011112222" }), ctx(s.slug));
    expect(startA.status).toBe(200);
    const a = { cookie: cookieOf(startA, "lo_bidv"), verificationId: (await startA.json()).verificationId as string };
    // 다른 사람이 본인확인을 마쳐 한도(1건)가 찬다
    await s.verified();
    const rows = await db.identityVerification.count();
    const blocked = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, phone: "01033334444" }), ctx(s.slug));
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toEqual({ error: "trial_limit_exceeded", message: "지금은 가입할 수 없어요. 쇼핑몰에 문의해 주세요" });
    // 본인확인 기록을 만들지 않아 문자를 보내지 않는다
    expect(await db.identityVerification.count()).toBe(rows);
    // 먼저 시작해 둔 본인확인도 다시 보내기를 막는다(보낸 횟수 그대로)
    const before = await db.identityVerification.findUniqueOrThrow({ where: { id: a.verificationId } });
    await db.identityVerification.update({ where: { id: a.verificationId }, data: { lastSentAt: new Date(Date.now() - 10 * 60_000) } });
    const resend = await resendRoute(post(`${s.base}/verification/resend`, { verificationId: a.verificationId }, a.cookie), ctx(s.slug));
    expect(resend.status).toBe(403);
    expect(await resend.json()).toMatchObject({ error: "trial_limit_exceeded" });
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: a.verificationId } })).sendCount).toBe(before.sendCount);
    // 한도로 막힌 시작은 기록을 만들지 않으므로 같은 IP 하루 시작 횟수(기록 수로 셈)도 늘지 않는다
    expect(await db.identityVerification.count({ where: { purpose: "BUYER_SIGNUP", sellerId: s.seller.id } })).toBe(2);
    // 판매자 본인확인 경로(대표자 가입·비밀번호 재설정)는 이 한도를 보지 않는다
    const provider = new FakeIdentityProvider();
    const rep = await startSellerSignupVerification(db, provider, { ...IDV_INPUT, phone: "01055556666" }, { ip: "203.0.113.9" });
    const reset = await startSellerPasswordReset(db, provider, { email: "owner@example.com", shopSlug: s.slug, person: IDV_INPUT });
    if (!rep.ok || !reset.ok) throw new Error("판매자 본인확인 시작 실패");
    // 판매자 쪽 다시 보내기도 막히지 않는다(한도가 찬 체험 판매자의 비밀번호 재설정 포함)
    await db.identityVerification.updateMany({ where: { id: { in: [rep.verificationId, reset.verificationId] } }, data: { lastSentAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await resendIdentityCode(db, provider, rep.verificationId, { sellerId: null, purpose: "SELLER_REPRESENTATIVE", ownerToken: rep.ownerToken })).toEqual({ ok: true });
    expect(await resendIdentityCode(db, provider, reset.verificationId, { sellerId: s.seller.id, purpose: "PASSWORD_RESET", ownerToken: reset.ownerToken })).toEqual({ ok: true });
  });

  it("체험이 아닌(구독 중) 쇼핑몰은 체험 한도와 상관없이 본인확인을 시작한다", async () => {
    const s = await shop();
    await db.subscriptionPlan.upsert({
      where: { code: "STANDARD" },
      update: { trialIdentityLimit: 0 },
      create: { code: "STANDARD", name: "스탠다드", listPrice: 300000, salePrice: 199000, trialIdentityLimit: 0 },
    });
    const plan = await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } });
    await db.sellerSubscription.create({ data: { sellerId: s.seller.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) } });
    expect((await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(s.slug))).status).toBe(200);
    // 체험이 아니면 본인확인 사용량(전체 건수 COUNT)을 세지 않는다. 체험이면 센다.
    let counts = 0;
    const counting = new Proxy(db, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "identityVerification") {
          return new Proxy(v, { get: (d, m) => (m === "count" ? (...a: unknown[]) => (counts++, d.count(...(a as [never]))) : Reflect.get(d, m)) });
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as PrismaClient;
    expect(await buyerSignupIdentityLimitReached(counting, s.seller.id)).toBe(false);
    expect(counts).toBe(0);
    await db.sellerSubscription.deleteMany({ where: { sellerId: s.seller.id } });
    expect(await buyerSignupIdentityLimitReached(counting, s.seller.id)).toBe(true);
    expect(counts).toBe(1);
  });
  it("같은 attemptKey의 재시도는 그사이 동의 문서 버전이 바뀌어도(보낸 버전이 지금과 달라도) 이미 시작한 본인확인을 돌려주고, 새 키는 409로 막는다", async () => {
    const s = await shop();
    const fake = identityProvider() as FakeIdentityProvider;
    const key = crypto.randomUUID();
    const first = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(s.slug));
    expect(first.status).toBe(200);
    const { verificationId } = await first.json();
    const sent = fake.sent.length;
    // 응답이 끊긴 사이 배포로 문서 버전이 올라간 상황: 열린 화면은 옛 버전을 그대로 다시 보낸다
    const outdated = { ...SIGNUP_CONSENT, termsVersion: "2020-01-01.v0" };
    const again = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...outdated, attemptKey: key }), ctx(s.slug));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ verificationId });
    expect(fake.sent.length).toBe(sent);
    // 새로 시작하는 요청은 지금 버전이어야 한다
    const fresh = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...outdated, attemptKey: crypto.randomUUID() }), ctx(s.slug));
    expect(fresh.status).toBe(409);
    expect((await fresh.json()).error).toBe("consent_outdated");
    expect(await db.identityVerification.count({ where: { sellerId: s.seller.id } })).toBe(1);
  });
  it("attemptKey로 다시 시작하면 같은 본인확인을 같은 쿠키 값으로 돌려주고 문자·일일 횟수는 다시 쓰지 않는다", async () => {
    const s = await shop();
    const key = crypto.randomUUID();
    const first = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(s.slug));
    expect(first.status).toBe(200);
    const oldCookie = cookieOf(first, "lo_bidv");
    const { verificationId } = await first.json();
    // 응답이 끊겨 쿠키 없이 같은 키로 다시 보낸다
    const again = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(s.slug));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ verificationId });
    expect(oldCookie).toMatch(/^lo_bidv=.+/);
    expect(cookieOf(again, "lo_bidv")).toBe(oldCookie);
    expect(await db.identityVerification.count({ where: { sellerId: s.seller.id } })).toBe(1);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: verificationId } })).sendCount).toBe(1);
    // 어느 응답의 쿠키가 남아도 확인된다
    expect((await confirmRoute(post(`${s.base}/verification/confirm`, { verificationId, code: "000000" }, oldCookie), ctx(s.slug))).status).toBe(200);
    // 확인을 마친 뒤 같은 키면 새로 만들지 않고 409
    const done = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(s.slug));
    expect(done.status).toBe(409);
    expect((await done.json()).error).toBe("already_verified");
    // 다른 키면 새로 만든다
    expect((await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: crypto.randomUUID() }), ctx(s.slug))).status).toBe(200);
    expect(await db.identityVerification.count({ where: { sellerId: s.seller.id } })).toBe(2);
    // 키가 UUID가 아니면 400
    expect((await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: "abc" }), ctx(s.slug))).status).toBe(400);
  });

  it("같은 attemptKey로 동시에 시작해도 기록·문자는 한 번이고(보내는 중에 온 요청은 409), 다른 쇼핑몰의 같은 키는 따로 만든다", async () => {
    const a = await shop();
    const b = await shop();
    const key = crypto.randomUUID();
    const rs = await Promise.all([1, 2, 3].map(() => startRoute(post(`${a.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(a.slug))));
    const bodies = await Promise.all(rs.map((r) => r.json()));
    expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(rs.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    for (const [i, r] of rs.entries()) if (r.status === 409) expect(bodies[i].error).toBe("start_in_progress");
    const ids = new Set(bodies.filter((_, i) => rs[i].status === 200).map((x) => x.verificationId));
    expect(ids.size).toBe(1);
    const [v] = await db.identityVerification.findMany({ where: { sellerId: a.seller.id } });
    expect(v.sendCount).toBe(1);
    expect((await startRoute(post(`${b.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(b.slug))).status).toBe(200);
    expect(await db.identityVerification.count({ where: { sellerId: b.seller.id } })).toBe(1);
  });
  it("같은 attemptKey로 다시 시작할 때 유효한 현재 쿠키가 있으면 토큰을 바꾸지 않는다", async () => {
    const s = await shop();
    const key = crypto.randomUUID();
    const first = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(s.slug));
    const cookie = cookieOf(first, "lo_bidv");
    const { verificationId } = await first.json();
    const again = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }, cookie), ctx(s.slug));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ verificationId });
    expect(cookieOf(again, "lo_bidv")).toBe(cookie);
    expect((await confirmRoute(post(`${s.base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(s.slug))).status).toBe(200);
  });

  // 첫 문자 발송을 게이트로 멈출 수 있는 공급자. entered는 sendCode에 들어온 횟수.
  function gatedProvider() {
    const fake = identityProvider() as FakeIdentityProvider;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const state = { entered: 0, release };
    const provider = new Proxy(fake, {
      get(t, p, r) {
        if (p !== "sendCode") return Reflect.get(t, p, r);
        return async (...args: Parameters<FakeIdentityProvider["sendCode"]>) => {
          state.entered++;
          await gate;
          return t.sendCode(...args);
        };
      },
    });
    return { provider, state };
  }
  async function until(cond: () => boolean | Promise<boolean>, what: string) {
    for (let i = 0; i < 300; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(what);
  }

  it("첫 요청이 문자를 보내는 사이 같은 attemptKey로 다시 오면 기다리지 않고 409 start_in_progress, 발송이 끝난 뒤에는 같은 기록·발송 1회", async () => {
    const s = await shop();
    const key = crypto.randomUUID();
    const { provider, state } = gatedProvider();
    const first = startBuyerSignupVerification(db, provider, s.seller.id, { ...IDV_INPUT, ...SIGNUP_CONSENT }, { attemptKey: key });
    await until(() => state.entered === 1, "첫 요청이 발송에 들어가지 않았어요");
    // 발송 중인 첫 요청은 트랜잭션·잠금을 쥐고 있지 않다
    const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM pg_locks WHERE locktype = 'advisory'`;
    expect(n).toBe(0n);
    expect(await startBuyerSignupVerification(db, provider, s.seller.id, { ...IDV_INPUT, ...SIGNUP_CONSENT }, { attemptKey: key })).toEqual({ ok: false, reason: "start_in_progress" });
    const res = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(s.slug));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "start_in_progress", message: BUYER_SIGNUP_MESSAGES.start_in_progress });
    state.release();
    const a = await first;
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const again = await startBuyerSignupVerification(db, provider, s.seller.id, { ...IDV_INPUT, ...SIGNUP_CONSENT }, { attemptKey: key });
    expect(again).toMatchObject({ ok: true, verificationId: a.verificationId });
    expect(state.entered).toBe(1);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: a.verificationId } })).sendCount).toBe(1);
  });

  it("첫 문자 발송이 실패하면 기록은 실패로 남고 키를 비워, 같은 attemptKey로 다시 시작하면 새로 만들어 한 번 보낸다", async () => {
    const s = await shop();
    const key = crypto.randomUUID();
    const fake = identityProvider() as FakeIdentityProvider;
    fake.failNext("error");
    expect(await startBuyerSignupVerification(db, fake, s.seller.id, { ...IDV_INPUT, ...SIGNUP_CONSENT }, { attemptKey: key })).toEqual({ ok: false, reason: "provider_error" });
    expect(await db.identityVerification.findMany({ where: { sellerId: s.seller.id } })).toMatchObject([{ status: "FAILED", attemptKeyHash: null, sendCount: 0 }]);
    const sentBefore = fake.sent.length;
    const again = await startBuyerSignupVerification(db, fake, s.seller.id, { ...IDV_INPUT, ...SIGNUP_CONSENT }, { attemptKey: key });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(fake.sent.length - sentBefore).toBe(1);
    expect(await db.identityVerification.findUniqueOrThrow({ where: { id: again.verificationId } })).toMatchObject({ status: "PENDING", sendCount: 1 });
  });

  it("첫 문자를 보낸 뒤 쿠키 없는 같은 attemptKey 재요청이 동시에 여러 번 와도 모두 첫 응답과 같은 쿠키를 받는다(도착 순서와 상관없이 유효)", async () => {
    const s = await shop();
    const key = crypto.randomUUID();
    const first = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(s.slug));
    const cookie = cookieOf(first, "lo_bidv");
    const { verificationId } = await first.json();
    const rs = await Promise.all([1, 2, 3].map(() => startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(s.slug))));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(rs.map((r) => cookieOf(r, "lo_bidv"))).toEqual([cookie, cookie, cookie]);
    expect((await confirmRoute(post(`${s.base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(s.slug))).status).toBe(200);
  });

  it("보내는 중으로 남은 채 앞 요청이 멈춘 기록은 같은 요청 id로 다시 보내지 않고, 버린 뒤 새 기록·새 요청 id로 한 번 보낸다. 늦게 끝난 앞 요청은 실패", async () => {
    const s = await shop();
    const key = crypto.randomUUID();
    const { provider, state } = gatedProvider();
    const late = startBuyerSignupVerification(db, provider, s.seller.id, { ...IDV_INPUT, ...SIGNUP_CONSENT }, { attemptKey: key });
    await until(() => state.entered === 1, "첫 요청이 발송에 들어가지 않았어요");
    const [stalled] = await db.identityVerification.findMany({ where: { sellerId: s.seller.id } });
    // 앞 요청이 발송 중에 멈춘 것처럼 20초보다 오래 전에 보내기 시작한 것으로 되돌린다
    await db.identityVerification.update({ where: { id: stalled.id }, data: { sendStartedAt: new Date(Date.now() - 30_000) } });
    const fake = identityProvider() as FakeIdentityProvider;
    const sentBefore = fake.sent.length;
    const r = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, attemptKey: key }), ctx(s.slug));
    expect(r.status).toBe(200);
    const { verificationId } = await r.json();
    expect(verificationId).not.toBe(stalled.id);
    expect(fake.sent.length - sentBefore).toBe(1);
    const fresh = await db.identityVerification.findUniqueOrThrow({ where: { id: verificationId } });
    expect(fresh).toMatchObject({ status: "PENDING", sendCount: 1 });
    expect(fresh.requestId).not.toBe(stalled.requestId);
    expect(await db.identityVerification.findUniqueOrThrow({ where: { id: stalled.id } })).toMatchObject({ status: "FAILED", attemptKeyHash: null, sendCount: 0 });
    // 멈췄던 앞 요청이 늦게 끝나도 버린 기록을 되살리지 않고 실패를 돌려준다
    state.release();
    expect(await late).toEqual({ ok: false, reason: "provider_error" });
    expect(await db.identityVerification.findUniqueOrThrow({ where: { id: stalled.id } })).toMatchObject({ status: "FAILED", sendCount: 0 });
    const cookie = cookieOf(r, "lo_bidv");
    expect((await confirmRoute(post(`${s.base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(s.slug))).status).toBe(200);
  });

  it("같은 IP에서 5건이 동시에 시작해 발송이 느려도 잠금을 기다리지 않고 모두 발송에 들어가며 timeout 없이 끝난다", async () => {
    const s = await shop();
    const { provider, state } = gatedProvider();
    const runs = Array.from({ length: 5 }, () => startBuyerSignupVerification(db, provider, s.seller.id, { ...IDV_INPUT, ...SIGNUP_CONSENT }, { ip: "203.0.113.9", attemptKey: crypto.randomUUID() }));
    await until(() => state.entered === 5, "발송 중인 요청이 다른 요청을 막았어요");
    state.release();
    const rs = await Promise.all(runs);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(await db.identityVerification.count({ where: { sellerId: s.seller.id, sendCount: 1 } })).toBe(5);
  });

  it("인증번호 확인에 성공하면 저장된 본인확인 결과(NFKC 정규화한 이름·휴대폰·생년월일)를 돌려준다", async () => {
    const s = await shop();
    const st = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT, name: " Ｋｉｍ구매 ", phone: "010-9999-1234" }), ctx(s.slug));
    const cookie = cookieOf(st, "lo_bidv");
    const { verificationId } = await st.json();
    const c = await confirmRoute(post(`${s.base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(s.slug));
    expect(c.status).toBe(200);
    expect(await c.json()).toEqual({ ok: true, identity: { name: "Kim구매", phone: "01099991234", birthDate: "1995-05-05" } });
  });

  it("가입 응답이 끊겨 같은 요청을 다시 보내면 같은 회원으로 201·세션을 다시 주고, 다른 비밀번호·아이디·쿠키 없음은 거부한다", async () => {
    const s = await shop();
    const v = await s.verified();
    const first = await s.signup(v);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, broadcastNickname: "카드왕" });
    // 헤더만 도착하고 본문이 끊긴 경우에도 쿠키가 남아 있어야 다시 보낼 수 있다
    expect(first.headers.getSetCookie().some((c) => c.startsWith("lo_bidv="))).toBe(false);
    const member = await db.buyerMember.findFirstOrThrow({ where: { sellerId: s.seller.id } });
    const attempts = (await db.identityVerification.findUniqueOrThrow({ where: { id: v.verificationId } })).useAttemptCount;
    // 같은 요청을 다시 보내면(대소문자만 다른 아이디 포함) 같은 회원으로 201과 세션
    const again = await s.signup(v, { loginId: "Buyer01@Example.com" });
    expect(again.status).toBe(201);
    expect(await again.json()).toEqual({ ok: true, broadcastNickname: "카드왕" });
    expect(cookieOf(again, "lo_buyer")).toMatch(/^lo_buyer=.+/);
    expect(await db.buyerMember.count({ where: { sellerId: s.seller.id } })).toBe(1);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: v.verificationId } })).subjectId).toBe(member.id);
    // 다른 비밀번호·다른 아이디·쿠키 없음은 지금처럼 verification_invalid
    for (const [body, cookie] of [
      [{ password: "other-pass-1" }, v.cookie],
      [{ loginId: "buyer02@example.com" }, v.cookie],
      [{}, undefined],
    ] as const) {
      const r = await s.signup({ verificationId: v.verificationId, cookie }, body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await r.json()).error).toBe("verification_invalid");
      expect(cookieOf(r, "lo_buyer")).toBe("");
    }
    // 재전송은 시도 횟수에 넣지 않는다
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: v.verificationId } })).useAttemptCount).toBe(attempts);
    expect(await db.buyerMember.count({ where: { sellerId: s.seller.id } })).toBe(1);
  });
  it("공급자가 돌려준 이름도 NFKC·앞뒤 공백 정리 뒤 저장하고 confirm 응답·가입 회원 이름이 같다", async () => {
    const s = await shop();
    const st = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(s.slug));
    const cookie = cookieOf(st, "lo_bidv");
    const { verificationId } = await st.json();
    const { requestId } = await db.identityVerification.findUniqueOrThrow({ where: { id: verificationId } });
    (identityProvider() as FakeIdentityProvider).complete(requestId, { ci: "ci-kim", name: " Ｋｉｍ ", phone: "010-1234-5678", birthDate: new Date("1995-05-05") });
    const c = await confirmRoute(post(`${s.base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(s.slug));
    expect(await c.json()).toEqual({ ok: true, identity: { name: "Kim", phone: "01012345678", birthDate: "1995-05-05" } });
    expect(await db.identityVerification.findUniqueOrThrow({ where: { id: verificationId } })).toMatchObject({ name: "Kim", phone: "01012345678" });
    expect((await s.signup({ cookie, verificationId })).status).toBe(201);
    expect((await db.buyerMember.findFirstOrThrow({ where: { sellerId: s.seller.id } })).name).toBe("Kim");
  });

  it("같은 가입 요청 두 개가 동시에 와도 둘 다 201·같은 회원이고 회원 1명, 시도 횟수는 한 번만 는다", async () => {
    const s = await shop();
    const v = await s.verified();
    const rs = await Promise.all([s.signup(v), s.signup(v)]);
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    expect(await Promise.all(rs.map((r) => r.json()))).toEqual([
      { ok: true, broadcastNickname: "카드왕" },
      { ok: true, broadcastNickname: "카드왕" },
    ]);
    expect(await db.buyerMember.count({ where: { sellerId: s.seller.id } })).toBe(1);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: v.verificationId } })).useAttemptCount).toBe(1);
  });
  it("시도 횟수 4에서 같은 요청 두 개가 겹치고 이긴 쪽이 회원 생성 직전에 멈춰 있어도, 진 쪽은 기다렸다가 같은 회원으로 201", async () => {
    const provider = new FakeIdentityProvider();
    const { seller } = await createSeller();
    const { verification, ownerToken } = await startIdv(provider, { purpose: "BUYER_SIGNUP", sellerId: seller.id });
    expect((await confirmIdv(provider, verification, ownerToken)).ok).toBe(true);
    await db.identityVerification.update({ where: { id: verification.id }, data: { useAttemptCount: MAX_SIGNUP_ATTEMPTS_PER_VERIFICATION - 1 } });
    const input = { sellerId: seller.id, verificationId: verification.id, ownerToken, loginId: "buyer01@example.com", password: "pw-123456", broadcastNickname: "닉" };
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    // 이긴 쪽: 트랜잭션 안에서 회원을 만들기 직전에 멈춘다
    const paused = new Proxy(db, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "$transaction") {
          return (fn: (tx: object) => unknown, o?: unknown) =>
            t.$transaction(
              (tx) =>
                fn(
                  new Proxy(tx, {
                    get(x, k, r) {
                      const m = Reflect.get(x, k, r);
                      if (k !== "buyerMember") return m;
                      return new Proxy(m, { get: (d, f) => (f === "create" ? async (a: never) => (await gate, d.create(a)) : Reflect.get(d, f)) });
                    },
                  }),
                ) as Promise<unknown>,
              o as never,
            );
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as PrismaClient;
    const winner = signupBuyer(paused, provider, input);
    await new Promise((r) => setTimeout(r, 400));
    const loser = signupBuyer(db, provider, input);
    await new Promise((r) => setTimeout(r, 500));
    release(null);
    const [a, b] = await Promise.all([winner, loser]);
    expect(a).toMatchObject({ ok: true, resumed: false });
    expect(b).toMatchObject({ ok: true, resumed: true });
    if (a.ok && b.ok) expect(b.memberId).toBe(a.memberId);
    expect(await db.buyerMember.count({ where: { sellerId: seller.id } })).toBe(1);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: verification.id } })).useAttemptCount).toBe(MAX_SIGNUP_ATTEMPTS_PER_VERIFICATION);
  });
  it("가입이 본인확인을 읽은 뒤 미가입 정리가 그 기록을 비식별하면 가입은 거부되고 회원·연결이 생기지 않는다(정리와 소진 경합)", async () => {
    const provider = new FakeIdentityProvider();
    const { seller } = await createSeller();
    const { verification, ownerToken } = await startIdv(provider, { purpose: "BUYER_SIGNUP", sellerId: seller.id });
    expect((await confirmIdv(provider, verification, ownerToken)).ok).toBe(true);
    // 가입 트랜잭션이 시작되기 직전에 정리 작업이 (유효 시간이 지났다고 보는 시계로) 먼저 커밋된다
    const racing = new Proxy(db, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "$transaction") {
          return async (fn: never, o?: never) => {
            expect(await purgeUnfinishedSignupVerifications(db, new Date(Date.now() + 86_400_000), seller.id)).toBe(1);
            return t.$transaction(fn, o);
          };
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as PrismaClient;
    const r = await signupBuyer(racing, provider, { sellerId: seller.id, verificationId: verification.id, ownerToken, loginId: "race@example.com", password: "pw-123456", broadcastNickname: "경합" });
    expect(r).toEqual({ ok: false, reason: "verification_invalid" });
    expect(await db.buyerMember.count({ where: { sellerId: seller.id } })).toBe(0);
    const row = await db.identityVerification.findUniqueOrThrow({ where: { id: verification.id } });
    expect(row).toMatchObject({ consumedAt: null, subjectId: null, ciHash: null, anonymizedAt: expect.any(Date) });
  });
  it("다른 본인확인으로 같은 아이디가 동시에 가입돼 회원 생성이 유니크 충돌로 실패해도 409이고 시도 횟수는 남는다", async () => {
    const provider = new FakeIdentityProvider();
    const { seller } = await createSeller();
    const a = await startIdv(provider, { purpose: "BUYER_SIGNUP", sellerId: seller.id, person: { name: "가", phone: "01011110001" } });
    const b = await startIdv(provider, { purpose: "BUYER_SIGNUP", sellerId: seller.id, person: { name: "나", phone: "01011110002" } });
    expect((await confirmIdv(provider, a.verification, a.ownerToken)).ok).toBe(true);
    expect((await confirmIdv(provider, b.verification, b.ownerToken)).ok).toBe(true);
    const base = { sellerId: seller.id, loginId: "same@example.com", password: "pw-123456" };
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    // B는 중복 확인을 통과한 뒤 회원을 만들기 직전에 멈춘다
    const paused = new Proxy(db, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "$transaction") {
          return (fn: (tx: object) => unknown, o?: unknown) =>
            t.$transaction(
              (tx) =>
                fn(
                  new Proxy(tx, {
                    get(x, k, r) {
                      const m = Reflect.get(x, k, r);
                      if (k !== "buyerMember") return m;
                      return new Proxy(m, { get: (d, f) => (f === "create" ? async (q: never) => (await gate, d.create(q)) : Reflect.get(d, f)) });
                    },
                  }),
                ) as Promise<unknown>,
              o as never,
            );
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as PrismaClient;
    const slow = signupBuyer(paused, provider, { ...base, verificationId: b.verification.id, ownerToken: b.ownerToken, broadcastNickname: "나" });
    await new Promise((r) => setTimeout(r, 400));
    expect((await signupBuyer(db, provider, { ...base, verificationId: a.verification.id, ownerToken: a.ownerToken, broadcastNickname: "가" })).ok).toBe(true);
    release(null);
    expect(await slow).toEqual({ ok: false, reason: "login_id_taken" });
    expect(BUYER_SIGNUP_STATUS.login_id_taken).toBe(409);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: b.verification.id } })).useAttemptCount).toBe(1);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: b.verification.id } })).consumedAt).toBeNull();
  });
  it("가입 감사 로그를 쓰지 못하면 회원도 만들지 않고 본인확인도 소진하지 않는다(같은 트랜잭션)", async () => {
    const provider = new FakeIdentityProvider();
    const { seller } = await createSeller();
    const { verification, ownerToken } = await startIdv(provider, { purpose: "BUYER_SIGNUP", sellerId: seller.id });
    expect((await confirmIdv(provider, verification, ownerToken)).ok).toBe(true);
    const input = { sellerId: seller.id, verificationId: verification.id, ownerToken, loginId: "buyer01@example.com", password: "pw-123456", broadcastNickname: "닉" };
    await expect(signupBuyer(failingAudit(db, "buyer.signup"), provider, input)).rejects.toThrow("감사 로그 쓰기 실패");
    expect(await db.buyerMember.count()).toBe(0);
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: verification.id } })).consumedAt).toBeNull();
    // 다시 하면 가입된다
    expect((await signupBuyer(db, provider, input)).ok).toBe(true);
  });
});
