import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as loginRoute } from "../../app/api/shop/[slug]/auth/login/route";
import { POST as signupRoute } from "../../app/api/shop/[slug]/signup/route";
import { POST as confirmRoute } from "../../app/api/shop/[slug]/signup/verification/confirm/route";
import { POST as resendRoute } from "../../app/api/shop/[slug]/signup/verification/resend/route";
import { POST as startRoute } from "../../app/api/shop/[slug]/signup/verification/route";
import { BUYER_SIGNUP_MESSAGES, BUYER_SIGNUP_VERIFY_DAILY_LIMIT_PER_IP, MAX_SIGNUP_ATTEMPTS_PER_VERIFICATION, signupBuyer } from "../../lib/server/buyers/signup";
import { prisma } from "../../lib/server/db";
import { startSellerPasswordReset } from "../../lib/server/auth/passwordReset";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { buyerSignupIdentityLimitReached, resendIdentityCode } from "../../lib/server/identity/verification";
import { startSellerSignupVerification } from "../../lib/server/sellers/application";
import { IDV_INPUT, confirmIdv, createSeller, db, resetDb, startIdv } from "./helpers";

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
    const s = await startRoute(post(`${base}/verification`, { ...IDV_INPUT, ...person }), ctx(slug));
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
  it("본인확인 시작 → 인증번호 확인 → 가입하면 201로 바로 로그인되고, 이름·휴대폰은 본인확인 결과를 쓰며 동의를 기록한다", async () => {
    const s = await shop();
    const start = await startRoute(post(`${s.base}/verification`, IDV_INPUT), ctx(s.slug));
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
      [{ agreedTerms: false }, "terms_required"],
      [{ agreedPrivacy: "true" }, "terms_required"],
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
    const start = await startRoute(post(`${s.base}/verification`, IDV_INPUT), ctx(s.slug));
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
    const start = await startRoute(post(`${s.base}/verification`, IDV_INPUT), ctx(s.slug));
    const cookie = cookieOf(start, "lo_bidv");
    const { verificationId } = await start.json();
    expect((await resendRoute(post(`${s.base}/verification/resend`, { verificationId }, cookie), ctx(s.slug))).status).toBe(429);
    expect((await confirmRoute(post(`${s.base}/verification/confirm`, { verificationId, code: "000000" }, "lo_bidv=someone-else"), ctx(s.slug))).status).toBe(404);
    const wrong = await confirmRoute(post(`${s.base}/verification/confirm`, { verificationId, code: "987654" }, cookie), ctx(s.slug));
    expect(wrong.status).toBe(400);
  });

  it("없는 쇼핑몰은 404, 잠긴 쇼핑몰은 402, 인적사항이 틀리면 400, 같은 IP·같은 쇼핑몰 하루 10회를 넘으면 429", async () => {
    const s = await shop();
    expect((await startRoute(post(`/api/shop/nope/signup/verification`, IDV_INPUT), ctx("nope"))).status).toBe(404);
    expect((await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, carrier: "SKY" }), ctx(s.slug))).status).toBe(400);
    for (let i = 0; i < BUYER_SIGNUP_VERIFY_DAILY_LIMIT_PER_IP; i++) {
      expect((await startRoute(post(`${s.base}/verification`, IDV_INPUT), ctx(s.slug))).status).toBe(200);
    }
    const limited = await startRoute(post(`${s.base}/verification`, IDV_INPUT), ctx(s.slug));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "daily_limit_exceeded", message: BUYER_SIGNUP_MESSAGES.daily_limit_exceeded });
    // 다른 쇼핑몰은 따로 센다
    const other = await shop();
    expect((await startRoute(post(`${other.base}/verification`, IDV_INPUT), ctx(other.slug))).status).toBe(200);
    // 잠긴 쇼핑몰(체험 종료·구독 없음)
    await db.seller.update({ where: { id: other.seller.id }, data: { trialEndsAt: new Date("2000-01-01T00:00:00Z") } });
    const locked = await startRoute(post(`${other.base}/verification`, IDV_INPUT), ctx(other.slug));
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
    const start = await startRoute(post(`${a.base}/verification`, IDV_INPUT), ctx(a.slug));
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
        agreedTerms: true,
        agreedPrivacy: true,
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
    const startA = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, phone: "01011112222" }), ctx(s.slug));
    expect(startA.status).toBe(200);
    const a = { cookie: cookieOf(startA, "lo_bidv"), verificationId: (await startA.json()).verificationId as string };
    // 다른 사람이 본인확인을 마쳐 한도(1건)가 찬다
    await s.verified();
    const rows = await db.identityVerification.count();
    const blocked = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, phone: "01033334444" }), ctx(s.slug));
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
    expect((await startRoute(post(`${s.base}/verification`, IDV_INPUT), ctx(s.slug))).status).toBe(200);
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
  it("인증번호 확인에 성공하면 저장된 본인확인 결과(NFKC 정규화한 이름·휴대폰·생년월일)를 돌려준다", async () => {
    const s = await shop();
    const st = await startRoute(post(`${s.base}/verification`, { ...IDV_INPUT, name: " Ｋｉｍ구매 ", phone: "010-9999-1234" }), ctx(s.slug));
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
});
