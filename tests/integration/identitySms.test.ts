import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as applyRoute } from "../../app/api/seller-signup/apply/route";
import { POST as signupConfirmRoute } from "../../app/api/seller-signup/verification/confirm/route";
import { POST as signupResendRoute } from "../../app/api/seller-signup/verification/resend/route";
import { POST as signupStartRoute } from "../../app/api/seller-signup/verification/route";
import { POST as resetStartRoute } from "../../app/api/seller/password-reset/start/route";
import { POST as resetVerifyRoute } from "../../app/api/seller/password-reset/verify/route";
import { signupBuyer } from "../../lib/server/buyers/signup";
import { prisma } from "../../lib/server/db";
import { IDENTITY_ERROR_MESSAGES } from "../../lib/server/identity/messages";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { identityProvider } from "../../lib/server/identity/registry";
import {
  IDENTITY_PROVIDER_TIMEOUT,
  MAX_CODE_SENDS,
  MAX_OTP_FAILURES,
  OTP_TTL_MS,
  REQUEST_TTL_MS,
  RESEND_INTERVAL_MS,
  completeIdentityVerification,
  identityUsage,
  resendIdentityCode,
} from "../../lib/server/identity/verification";
import { IDV_INPUT, confirmIdv, createSeller, db, resetDb, startIdv } from "./helpers";

beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterEach(() => {
  IDENTITY_PROVIDER_TIMEOUT.ms = 10_000;
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const provider = new FakeIdentityProvider();
const ownerOf = (v: { sellerId: string | null; purpose: "BUYER_SIGNUP" | "SELLER_REPRESENTATIVE" | "PASSWORD_RESET" }, ownerToken: string) => ({
  sellerId: v.sellerId,
  purpose: v.purpose,
  ownerToken,
});
const row = (id: string) => db.identityVerification.findUniqueOrThrow({ where: { id } });
const later = (from: Date | null, ms: number) => new Date((from ?? new Date()).getTime() + ms);

async function buyerIdv(sellerId: string, person = {}) {
  return startIdv(provider, { purpose: "BUYER_SIGNUP", sellerId, person });
}

describe("인증번호 오입력·만료·재전송 제한", () => {
  it(`${MAX_OTP_FAILURES}번 틀리면 그 요청은 실패로 끝나고, 맞는 번호도 더는 받지 않는다(형식이 틀린 번호도 센다)`, async () => {
    const { seller } = await createSeller();
    const { verification: v, ownerToken } = await buyerIdv(seller.id);
    expect(await confirmIdv(provider, v, ownerToken, "abc")).toEqual({ ok: false, reason: "wrong_code" });
    for (let i = 2; i < MAX_OTP_FAILURES; i++) expect(await confirmIdv(provider, v, ownerToken, "111111")).toEqual({ ok: false, reason: "wrong_code" });
    expect(await confirmIdv(provider, v, ownerToken, "111111")).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(await confirmIdv(provider, v, ownerToken)).toEqual({ ok: false, reason: "failed" });
    expect(await row(v.id)).toMatchObject({ status: "FAILED", otpFailCount: MAX_OTP_FAILURES, ciHash: null });
  });

  it("인증번호 유효 시간이 지나면 code_expired, 본인확인 시간이 지나면 expired(그 뒤 다시 보내기도 막힘)", async () => {
    const { seller } = await createSeller();
    const { verification: v, ownerToken } = await buyerIdv(seller.id);
    const sentAt = (await row(v.id)).lastSentAt;
    expect(await confirmIdv(provider, v, ownerToken, undefined, later(sentAt, OTP_TTL_MS))).toEqual({ ok: false, reason: "code_expired" });
    expect(await confirmIdv(provider, v, ownerToken, undefined, later(v.createdAt, REQUEST_TTL_MS))).toEqual({ ok: false, reason: "expired" });
    expect(await resendIdentityCode(db, provider, v.id, ownerOf(v, ownerToken))).toEqual({ ok: false, reason: "expired" });
    expect((await row(v.id)).status).toBe("EXPIRED");
  });

  it(`다시 보내기는 ${RESEND_INTERVAL_MS / 1000}초 간격, 처음 포함 ${MAX_CODE_SENDS}번까지. 동시에 눌러도 한 번만 보낸다`, async () => {
    const { seller } = await createSeller();
    const { verification: v, ownerToken } = await buyerIdv(seller.id);
    const o = ownerOf(v, ownerToken);
    expect(await resendIdentityCode(db, provider, v.id, o)).toEqual({ ok: false, reason: "resend_too_soon" });
    let at = later((await row(v.id)).lastSentAt, RESEND_INTERVAL_MS);
    const burst = await Promise.all(Array.from({ length: 5 }, () => resendIdentityCode(db, provider, v.id, o, at)));
    expect(burst.filter((r) => r.ok)).toHaveLength(1);
    expect((await row(v.id)).sendCount).toBe(2);
    for (let n = 3; n <= MAX_CODE_SENDS; n++) {
      at = later(at, RESEND_INTERVAL_MS);
      expect(await resendIdentityCode(db, provider, v.id, o, at)).toEqual({ ok: true });
    }
    expect(await resendIdentityCode(db, provider, v.id, o, later(at, RESEND_INTERVAL_MS))).toEqual({ ok: false, reason: "resend_limit" });
    // 다시 받은 번호로는 유효 시간이 새로 시작된다
    expect((await confirmIdv(provider, v, ownerToken, undefined, later(at, OTP_TTL_MS - 1000))).ok).toBe(true);
  });

  it("인증번호 확인을 동시에 여러 번 눌러도 모두 같은 결과이고, 확정·사용량은 한 번만", async () => {
    const { seller } = await createSeller();
    const { verification: v, ownerToken } = await buyerIdv(seller.id);
    const rs = await Promise.all(Array.from({ length: 5 }, () => confirmIdv(provider, v, ownerToken)));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(new Set(rs.map((r) => (r.ok ? r.verification.verifiedAt?.getTime() : 0))).size).toBe(1);
    expect(await identityUsage(db, seller.id)).toBe(1);
  });
});

describe("위조·재사용 결과 차단", () => {
  it("대행사 결과의 요청 id나 서비스(용도)가 우리 기록과 다르면 실패로 끝낸다", async () => {
    const { seller } = await createSeller();
    const a = await buyerIdv(seller.id);
    provider.overrideNextResult({ requestId: "idv-someone-else" });
    expect(await confirmIdv(provider, a.verification, a.ownerToken)).toEqual({ ok: false, reason: "failed" });
    const b = await buyerIdv(seller.id);
    provider.overrideNextResult({ purpose: "PASSWORD_RESET" });
    expect(await confirmIdv(provider, b.verification, b.ownerToken)).toEqual({ ok: false, reason: "failed" });
    expect((await row(a.verification.id)).status).toBe("FAILED");
    expect((await row(b.verification.id)).status).toBe("FAILED");
  });

  it("다른 세션(ownerToken)·다른 쇼핑몰·다른 용도로는 확인·재사용할 수 없고, 같은 결과로 두 번 가입할 수 없다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const { verification: v, ownerToken } = await buyerIdv(a.seller.id);
    expect(await confirmIdv(provider, v, "other-session")).toEqual({ ok: false, reason: "not_found" });
    expect((await confirmIdv(provider, v, ownerToken)).ok).toBe(true);
    expect(await completeIdentityVerification(db, provider, v.id, { sellerId: b.seller.id, purpose: "BUYER_SIGNUP", ownerToken })).toEqual({ ok: false, reason: "not_found" });
    expect(await completeIdentityVerification(db, provider, v.id, { sellerId: a.seller.id, purpose: "PASSWORD_RESET", ownerToken })).toEqual({ ok: false, reason: "not_found" });
    const signup = (loginId: string) =>
      signupBuyer(db, { sellerId: a.seller.id, verificationId: v.id, ownerToken, loginId, password: "pw-123456", broadcastNickname: loginId });
    expect((await signup("first")).ok).toBe(true);
    expect(await signup("second")).toEqual({ ok: false, reason: "verification_invalid" });
  });

  it("인증 대상 휴대폰번호가 바뀌면(결과의 번호가 요청 때와 다르면) 확정하지 않는다. 바뀐 번호는 새로 시작해 다시 인증한다", async () => {
    const { seller } = await createSeller();
    const first = await buyerIdv(seller.id);
    provider.complete(first.verification.requestId, { ci: "CI-1", name: IDV_INPUT.name, phone: "01099998888", birthDate: new Date("1995-05-05") });
    expect(await confirmIdv(provider, first.verification, first.ownerToken)).toEqual({ ok: false, reason: "failed" });
    const again = await buyerIdv(seller.id, { phone: "01099998888" });
    provider.complete(again.verification.requestId, { ci: "CI-1", name: IDV_INPUT.name, phone: "01099998888", birthDate: new Date("1995-05-05") });
    const r = await confirmIdv(provider, again.verification, again.ownerToken);
    expect(r).toMatchObject({ ok: true, verification: { phone: "01099998888", requestedPhone: "01099998888", method: "SMS" } });
  });
});

describe("공급자 장애·타임아웃·운영 키 없음", () => {
  it("인증번호 보내기 장애면 시작이 실패로 끝나고, 확인 장애·응답 없음(타임아웃)은 실패로 돌려주되 틀린 횟수로 세지 않는다", async () => {
    const { seller } = await createSeller();
    provider.failNext("error");
    await expect(buyerIdv(seller.id)).rejects.toThrow("provider_error");
    expect(await db.identityVerification.findFirstOrThrow({ orderBy: { createdAt: "desc" } })).toMatchObject({ status: "FAILED", sendCount: 0 });

    const { verification: v, ownerToken } = await buyerIdv(seller.id);
    provider.failNext("error");
    expect(await confirmIdv(provider, v, ownerToken)).toEqual({ ok: false, reason: "provider_error" });
    IDENTITY_PROVIDER_TIMEOUT.ms = 50;
    provider.failNext("hang");
    expect(await confirmIdv(provider, v, ownerToken)).toEqual({ ok: false, reason: "provider_error" });
    expect(await row(v.id)).toMatchObject({ status: "PENDING", otpFailCount: 0, ciHash: null });
    IDENTITY_PROVIDER_TIMEOUT.ms = 10_000;
    expect((await confirmIdv(provider, v, ownerToken)).ok).toBe(true);
  });

  it("운영에서 본인확인 키·필수 설정이 없으면 가입·비밀번호 찾기·신청 모두 503 「본인확인 서비스 준비 중이에요」(500 아님)", async () => {
    const post = (url: string, body: unknown) =>
      new Request(`http://localhost:3000${url}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" },
        body: JSON.stringify(body),
      });
    const env = process.env as Record<string, string | undefined>;
    const prev = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const rs = [
        await signupStartRoute(post("/api/seller-signup/verification", IDV_INPUT)),
        await signupResendRoute(post("/api/seller-signup/verification/resend", { verificationId: crypto.randomUUID() })),
        await signupConfirmRoute(post("/api/seller-signup/verification/confirm", { verificationId: crypto.randomUUID(), code: "000000" })),
        await applyRoute(post("/api/seller-signup/apply", { verificationId: crypto.randomUUID() })),
        await resetStartRoute(post("/api/seller/password-reset/start", { email: "a@example.com", shopSlug: "shop", person: IDV_INPUT })),
        await resetVerifyRoute(post("/api/seller/password-reset/verify", { verificationId: crypto.randomUUID() })),
      ];
      for (const r of rs) {
        expect(r.status).toBe(503);
        expect(await r.json()).toEqual({ error: "identity_unavailable", message: "본인확인 서비스 준비 중이에요" });
      }
    } finally {
      env.NODE_ENV = prev;
    }
    expect(await db.identityVerification.count()).toBe(0);
  });

  it("HTTP: 인적사항이 틀리면 400과 문구, 다른 브라우저의 요청 id는 404, 인증번호·비밀값은 응답·기록에 남지 않는다", async () => {
    const post = (url: string, body: unknown, cookie?: string) =>
      new Request(`http://localhost:3000${url}`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
    for (const bad of [{ ...IDV_INPUT, birth7: "9513321" }, { ...IDV_INPUT, carrier: "SKY" }, { ...IDV_INPUT, phone: "0212345678" }, { ...IDV_INPUT, name: "\u200b" }]) {
      const r = await signupStartRoute(post("/api/seller-signup/verification", bad));
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_identity_input", message: IDENTITY_ERROR_MESSAGES.invalid_identity_input });
    }
    const s = await signupStartRoute(post("/api/seller-signup/verification", IDV_INPUT));
    const cookie = (s.headers.get("set-cookie") ?? "").split(";")[0];
    const { verificationId } = await s.json();
    const other = await signupConfirmRoute(post("/api/seller-signup/verification/confirm", { verificationId, code: "000000" }, "lo_sidv=someone-else"));
    expect(other.status).toBe(404);
    const wrong = await signupConfirmRoute(post("/api/seller-signup/verification/confirm", { verificationId, code: "987654" }, cookie));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "wrong_code", message: "인증번호가 맞지 않아요. 다시 확인해 주세요" });
    const soon = await signupResendRoute(post("/api/seller-signup/verification/resend", { verificationId }, cookie));
    expect(soon.status).toBe(429);
    const stored = JSON.stringify([await db.identityVerification.findMany(), await db.auditLog.findMany()]);
    expect(stored).not.toContain("987654");
    expect(stored).not.toContain(cookie.split("=")[1]);
  });
});

describe("사용량·판매자 상태", () => {
  it("체험하기 중 구매자 휴대폰 본인확인은 성공 건만 한 번씩 세고, 한도를 넘으면 확정하지 않는다(실패·중복 확인은 세지 않음)", async () => {
    const { seller } = await createSeller();
    await db.subscriptionPlan.upsert({
      where: { code: "STANDARD" },
      update: { trialIdentityLimit: 2 },
      create: { code: "STANDARD", name: "스탠다드", listPrice: 300000, salePrice: 199000, trialIdentityLimit: 2 },
    });
    const failed = await buyerIdv(seller.id);
    provider.fail(failed.verification.requestId);
    expect(await confirmIdv(provider, failed.verification, failed.ownerToken)).toEqual({ ok: false, reason: "failed" });
    const one = await buyerIdv(seller.id);
    expect((await confirmIdv(provider, one.verification, one.ownerToken)).ok).toBe(true);
    expect((await confirmIdv(provider, one.verification, one.ownerToken)).ok).toBe(true);
    expect(await identityUsage(db, seller.id)).toBe(1);
    const two = await buyerIdv(seller.id);
    expect((await confirmIdv(provider, two.verification, two.ownerToken)).ok).toBe(true);
    const three = await buyerIdv(seller.id);
    expect(await confirmIdv(provider, three.verification, three.ownerToken)).toEqual({ ok: false, reason: "trial_limit_exceeded" });
    expect(await identityUsage(db, seller.id)).toBe(2);
    // 주문 알림 문자 한도(trialMessageLimit)와는 따로 센다
    expect((await db.subscriptionPlan.findUniqueOrThrow({ where: { code: "STANDARD" } })).trialMessageLimit).toBe(100);
  });

  it("본인확인 성공은 판매자 승인 상태·체험 기간·대표자 정보·구독을 바꾸지 않는다", async () => {
    const { seller } = await createSeller();
    const before = await db.seller.findUniqueOrThrow({ where: { id: seller.id } });
    const buyer = await buyerIdv(seller.id);
    expect((await confirmIdv(provider, buyer.verification, buyer.ownerToken)).ok).toBe(true);
    const reset = await startIdv(provider, { purpose: "PASSWORD_RESET", sellerId: seller.id });
    expect((await confirmIdv(provider, reset.verification, reset.ownerToken)).ok).toBe(true);
    expect(await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).toEqual(before);
    expect(await db.sellerSubscription.count()).toBe(0);
  });
});
