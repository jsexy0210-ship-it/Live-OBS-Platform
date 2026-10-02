import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signupBuyer } from "../../lib/server/buyers/signup";
import { hashCi } from "../../lib/server/identity/ciHash";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { completeIdentityVerification, startIdentityVerification } from "../../lib/server/identity/verification";
import { createSeller, db, resetDb } from "./helpers";

beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const provider = new FakeIdentityProvider();
const person = (ci: string) => ({ ci, name: "홍길동", phone: "01012345678", birthDate: new Date("1995-05-05") });

async function verified(sellerId: string, ci: string) {
  const v = await startIdentityVerification(db, provider, { purpose: "BUYER_SIGNUP", sellerId });
  provider.complete(v.requestId, person(ci));
  const r = await completeIdentityVerification(db, provider, v.id);
  if (!r.ok) throw new Error(r.reason);
  return r.verification;
}

let n = 0;
const signup = (sellerId: string, verificationId: string) =>
  signupBuyer(db, { sellerId, verificationId, loginId: `user${++n}`, password: "pw-123456", broadcastNickname: `닉${n}` });

describe("PASS 본인인증 기록", () => {
  it("CI 원문은 저장하지 않고 HMAC 값만 남긴다", async () => {
    const { seller } = await createSeller();
    const v = await verified(seller.id, "RAW-CI-VALUE");
    expect(v.ciHash).toBe(hashCi("RAW-CI-VALUE"));
    const raw = JSON.stringify(await db.identityVerification.findMany());
    expect(raw).not.toContain("RAW-CI-VALUE");
  });

  it("인증 실패·만료는 VERIFIED가 되지 않는다", async () => {
    const { seller } = await createSeller();
    const failed = await startIdentityVerification(db, provider, { purpose: "BUYER_SIGNUP", sellerId: seller.id });
    provider.fail(failed.requestId);
    expect(await completeIdentityVerification(db, provider, failed.id)).toEqual({ ok: false, reason: "failed" });
    const old = await startIdentityVerification(db, provider, { purpose: "BUYER_SIGNUP", sellerId: seller.id, now: new Date(Date.now() - 3_600_000) });
    provider.complete(old.requestId, person("x"));
    expect(await completeIdentityVerification(db, provider, old.id)).toEqual({ ok: false, reason: "expired" });
  });
});

describe("운영 환경 차단", () => {
  it("운영 환경에서는 가짜 공급자로 만든 인증 기록을 완료 처리하지 않는다", async () => {
    const { seller } = await createSeller();
    const v = await startIdentityVerification(db, provider, { purpose: "BUYER_SIGNUP", sellerId: seller.id });
    provider.complete(v.requestId, person("CI-P"));
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      expect(await completeIdentityVerification(db, provider, v.id)).toEqual({ ok: false, reason: "failed" });
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    }
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: v.id } })).status).toBe("PENDING");
  });
});

describe("구매자 회원가입", () => {
  it("본인인증을 마치면 가입되고, 이름·휴대폰·생년월일은 인증 결과를 쓴다", async () => {
    const { seller } = await createSeller();
    const v = await verified(seller.id, "CI-A");
    const r = await signup(seller.id, v.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = await db.buyerMember.findUniqueOrThrow({ where: { id: r.memberId } });
    expect(m).toMatchObject({ name: "홍길동", phone: "01012345678", ciHash: hashCi("CI-A") });
  });

  it("같은 쇼핑몰에 같은 사람(CI)이 다시 가입하면 거부", async () => {
    const { seller } = await createSeller();
    expect((await signup(seller.id, (await verified(seller.id, "CI-A")).id)).ok).toBe(true);
    expect(await signup(seller.id, (await verified(seller.id, "CI-A")).id)).toEqual({ ok: false, reason: "already_member" });
  });

  it("다른 쇼핑몰의 본인인증으로는 가입할 수 없다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const v = await verified(a.seller.id, "CI-A");
    expect(await signup(b.seller.id, v.id)).toEqual({ ok: false, reason: "verification_invalid" });
  });

  it("인증 후 30분이 지나면 가입할 수 없다", async () => {
    const { seller } = await createSeller();
    const v = await verified(seller.id, "CI-A");
    expect(
      await signupBuyer(db, {
        sellerId: seller.id,
        verificationId: v.id,
        loginId: "late",
        password: "pw-123456",
        broadcastNickname: "늦음",
        now: new Date(v.verifiedAt!.getTime() + 31 * 60_000),
      }),
    ).toEqual({ ok: false, reason: "verification_invalid" });
  });
});
