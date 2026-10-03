import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { signupBuyer } from "../../lib/server/buyers/signup";
import { hashCi } from "../../lib/server/identity/ciHash";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { completeIdentityVerification } from "../../lib/server/identity/verification";
import { confirmIdv, createSeller, db, resetDb, startIdv } from "./helpers";

beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const provider = new FakeIdentityProvider();
const person = (ci: string) => ({ ci, name: "홍길동", phone: "01012345678", birthDate: new Date("1995-05-05") });
const owner = (sellerId: string, ownerToken: string) => ({ sellerId, purpose: "BUYER_SIGNUP" as const, ownerToken });

async function start(sellerId: string, now?: Date) {
  return startIdv(provider, { purpose: "BUYER_SIGNUP", sellerId, now });
}

async function verified(sellerId: string, ci: string) {
  const { verification, ownerToken } = await start(sellerId);
  provider.complete(verification.requestId, person(ci));
  const r = await confirmIdv(provider, verification, ownerToken);
  if (!r.ok) throw new Error(r.reason);
  return { verification: r.verification, ownerToken };
}

let n = 0;
const signup = (sellerId: string, v: { verification: { id: string }; ownerToken: string | undefined }, extra: { now?: Date } = {}) =>
  signupBuyer(db, {
    sellerId,
    verificationId: v.verification.id,
    ownerToken: v.ownerToken,
    loginId: `user${++n}`,
    password: "pw-123456",
    broadcastNickname: `닉${n}`,
    ...extra,
  });

describe("휴대폰 본인확인 기록", () => {
  it("CI 원문은 저장하지 않고 HMAC 값만 남긴다, 시작한 브라우저 값도 해시로만 저장", async () => {
    const { seller } = await createSeller();
    const v = await verified(seller.id, "RAW-CI-VALUE");
    expect(v.verification.ciHash).toBe(hashCi("RAW-CI-VALUE"));
    const raw = JSON.stringify(await db.identityVerification.findMany());
    expect(raw).not.toContain("RAW-CI-VALUE");
    expect(raw).not.toContain(v.ownerToken);
  });

  it("시작한 브라우저의 값이 없거나 다르면 인증을 완료할 수 없다", async () => {
    const { seller } = await createSeller();
    const { verification } = await start(seller.id);
    provider.complete(verification.requestId, person("CI-X"));
    expect(await completeIdentityVerification(db, provider, verification.id, owner(seller.id, "other-token"))).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      await completeIdentityVerification(db, provider, verification.id, { sellerId: seller.id, purpose: "BUYER_SIGNUP", ownerToken: undefined }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: verification.id } })).status).toBe("PENDING");
  });

  it("다른 쇼핑몰이나 다른 용도로는 인증을 완료할 수 없다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const { verification, ownerToken } = await start(a.seller.id);
    provider.complete(verification.requestId, person("CI-O"));
    expect(await completeIdentityVerification(db, provider, verification.id, owner(b.seller.id, ownerToken))).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      await completeIdentityVerification(db, provider, verification.id, { sellerId: a.seller.id, purpose: "PASSWORD_RESET", ownerToken }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: verification.id } })).status).toBe("PENDING");
  });

  it("인증 실패·만료는 VERIFIED가 되지 않는다", async () => {
    const { seller } = await createSeller();
    const failed = await start(seller.id);
    provider.fail(failed.verification.requestId);
    expect(await confirmIdv(provider, failed.verification, failed.ownerToken)).toEqual({
      ok: false,
      reason: "failed",
    });
    const old = await start(seller.id, new Date(Date.now() - 3_600_000));
    provider.complete(old.verification.requestId, person("x"));
    expect(await confirmIdv(provider, old.verification, old.ownerToken)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

describe("운영 환경 차단", () => {
  it("운영 환경에서는 가짜 공급자로 만든 인증 기록을 완료 처리하지 않는다", async () => {
    const { seller } = await createSeller();
    const { verification, ownerToken } = await start(seller.id);
    provider.complete(verification.requestId, person("CI-P"));
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    try {
      expect(await confirmIdv(provider, verification, ownerToken)).toEqual({
        ok: false,
        reason: "failed",
      });
    } finally {
      (process.env as Record<string, string | undefined>).NODE_ENV = prev;
    }
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: verification.id } })).status).toBe("PENDING");
  });
});

describe("구매자 회원가입", () => {
  it("본인인증을 마치면 가입되고, 이름·휴대폰·생년월일은 인증 결과를 쓴다", async () => {
    const { seller } = await createSeller();
    const r = await signup(seller.id, await verified(seller.id, "CI-A"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = await db.buyerMember.findUniqueOrThrow({ where: { id: r.memberId } });
    expect(m).toMatchObject({ name: "홍길동", phone: "01012345678", ciHash: hashCi("CI-A") });
  });

  it("같은 쇼핑몰에 같은 사람(CI)이 다시 가입하면 거부", async () => {
    const { seller } = await createSeller();
    expect((await signup(seller.id, await verified(seller.id, "CI-A"))).ok).toBe(true);
    expect(await signup(seller.id, await verified(seller.id, "CI-A"))).toEqual({ ok: false, reason: "already_member" });
  });

  it("한 번 쓴 본인인증으로는 다시 가입할 수 없다", async () => {
    const { seller } = await createSeller();
    const v = await verified(seller.id, "CI-A");
    expect((await signup(seller.id, v)).ok).toBe(true);
    await db.buyerMember.updateMany({ data: { status: "WITHDRAWN", deletedAt: new Date() } });
    expect(await signup(seller.id, v)).toEqual({ ok: false, reason: "verification_invalid" });
  });

  it("시작한 브라우저의 값이 다르면 가입할 수 없다", async () => {
    const { seller } = await createSeller();
    const v = await verified(seller.id, "CI-A");
    expect(await signup(seller.id, { ...v, ownerToken: "other" })).toEqual({ ok: false, reason: "verification_invalid" });
  });

  it("다른 쇼핑몰의 본인인증으로는 가입할 수 없다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    expect(await signup(b.seller.id, await verified(a.seller.id, "CI-A"))).toEqual({ ok: false, reason: "verification_invalid" });
  });

  it("인증 후 30분이 지나면 가입할 수 없다", async () => {
    const { seller } = await createSeller();
    const v = await verified(seller.id, "CI-A");
    expect(await signup(seller.id, v, { now: new Date(v.verification.verifiedAt!.getTime() + 31 * 60_000) })).toEqual({
      ok: false,
      reason: "verification_invalid",
    });
  });
});
