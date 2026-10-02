import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as httpComplete } from "../../app/api/seller/password-reset/complete/route";
import { POST as httpStart } from "../../app/api/seller/password-reset/start/route";
import { POST as httpVerify } from "../../app/api/seller/password-reset/verify/route";
import { loginSeller } from "../../lib/server/auth/login";
import {
  issueSellerPasswordResetGrant,
  passwordHasher,
  resetSellerPassword,
  resetStaffPassword,
  startSellerPasswordReset,
} from "../../lib/server/auth/passwordReset";
import { createSellerSession, resolveSellerSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { hashCi } from "../../lib/server/identity/ciHash";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { identityProvider } from "../../lib/server/identity/registry";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const provider = new FakeIdentityProvider();
const person = (ci: string) => ({ ci, name: "대표", phone: "01011112222", birthDate: new Date("1980-01-01") });
const NEW_PASSWORD = "new-password-123";

// 시작이 성공했다고 보고 결과를 꺼낸다(한도 테스트는 따로)
async function startOk(input: { email: string; shopSlug: string }, meta: { now?: Date } = {}) {
  const r = await startSellerPasswordReset(db, provider, input, meta);
  if (!r.ok) throw new Error(r.reason);
  return r;
}

// 대표자 CI가 등록된 쇼핑몰과 대표·직원 계정
async function shop(repCi = "REP-CI") {
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { representativeCiHash: hashCi(repCi), representativeVerifiedAt: new Date() } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const manager = await createSellerUser(seller.id, "MANAGER");
  return { seller, owner, manager };
}

// 시작 → PASS 완료(ci) → 재설정 권한 요청
async function grantFor(email: string, shopSlug: string, ci: string, now?: Date) {
  const s = await startOk({ email, shopSlug }, { now });
  provider.complete(s.requestId, person(ci));
  return { start: s, grant: await issueSellerPasswordResetGrant(db, provider, { verificationId: s.verificationId, ownerToken: s.ownerToken }, { now }) };
}

describe("판매자 비밀번호 찾기 (대표자 PASS)", () => {
  it("대표자 CI가 맞으면 재설정되고, 기존 로그인은 모두 끊기며, 새 비밀번호로만 로그인된다", async () => {
    const { seller, owner } = await shop();
    const before = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!before.ok) throw new Error("login failed");
    const { grant } = await grantFor(owner.email, seller.slug, "REP-CI");
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    expect(await resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: NEW_PASSWORD })).toEqual({ ok: true });
    expect(await resolveSellerSession(db, before.token)).toBeNull();
    expect((await loginSeller(db, { email: owner.email, password: PASSWORD }, {})).ok).toBe(false);
    expect((await loginSeller(db, { email: owner.email, password: NEW_PASSWORD }, {})).ok).toBe(true);
    const actions = (await db.auditLog.findMany({ where: { action: { startsWith: "auth.seller.password_reset" } }, orderBy: { createdAt: "asc" } })).map(
      (l) => l.action,
    );
    expect(actions).toEqual(["auth.seller.password_reset.start", "auth.seller.password_reset.granted", "auth.seller.password_reset.completed"]);
  });

  it("재설정 도중 옛 비밀번호로 진행된 로그인이 만든 세션도 무효다 (자격 버전)", async () => {
    const { seller, owner } = await shop();
    // 옛 비밀번호 확인까지 마친 로그인: 그 시점의 자격 버전을 들고 있다
    const verifiedVersion = (await db.sellerUser.findUniqueOrThrow({ where: { id: owner.id } })).credentialVersion;
    const { grant } = await grantFor(owner.email, seller.slug, "REP-CI");
    if (!grant.ok) throw new Error("grant failed");
    expect(await resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: NEW_PASSWORD })).toEqual({ ok: true });
    // 재설정이 끝난 뒤에 세션이 만들어져도
    const late = await createSellerSession(db, seller.id, owner.id, {}, verifiedVersion);
    expect(await resolveSellerSession(db, late.token)).toBeNull();
    // 새 비밀번호 로그인 세션은 유효
    const fresh = await loginSeller(db, { email: owner.email, password: NEW_PASSWORD }, {});
    if (!fresh.ok) throw new Error("login failed");
    expect(await resolveSellerSession(db, fresh.token)).not.toBeNull();
  });

  it("완료된 본인인증도 유효 시간(10분)이 지나면 재설정 권한을 받을 수 없다", async () => {
    const { seller, owner } = await shop();
    const t0 = new Date();
    // 대표자 CI가 달라 한 번 거부된 인증(완료됐지만 소진되지 않음)
    const { start, grant } = await grantFor(owner.email, seller.slug, "LATER-CI", t0);
    expect(grant).toEqual({ ok: false, reason: "reset_not_allowed" });
    // 나중에 대표자 CI가 바뀌어도 오래된 인증으로는 받을 수 없다
    await db.seller.update({ where: { id: seller.id }, data: { representativeCiHash: hashCi("LATER-CI") } });
    expect(
      await issueSellerPasswordResetGrant(
        db,
        provider,
        { verificationId: start.verificationId, ownerToken: start.ownerToken },
        { now: new Date(t0.getTime() + 11 * 60_000) },
      ),
    ).toEqual({ ok: false, reason: "reset_not_allowed" });
    expect(await db.passwordResetGrant.count()).toBe(0);
  });

  it("거부된 본인인증은 소진되어, 대표자 CI가 바뀐 뒤 유효 시간 안에 다시 써도 거부", async () => {
    const { seller, owner } = await shop();
    const { start, grant } = await grantFor(owner.email, seller.slug, "LATER-CI");
    expect(grant).toEqual({ ok: false, reason: "reset_not_allowed" });
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: start.verificationId } })).consumedAt).not.toBeNull();
    await db.seller.update({ where: { id: seller.id }, data: { representativeCiHash: hashCi("LATER-CI") } });
    expect(await issueSellerPasswordResetGrant(db, provider, { verificationId: start.verificationId, ownerToken: start.ownerToken })).toEqual({
      ok: false,
      reason: "reset_not_allowed",
    });
    expect(await db.passwordResetGrant.count()).toBe(0);
  });

  describe("권한을 쓰는 순간 다시 확인", () => {
    async function issued() {
      const s = await shop();
      const { grant } = await grantFor(s.owner.email, s.seller.slug, "REP-CI");
      if (!grant.ok) throw new Error("grant failed");
      return { ...s, grantToken: grant.grantToken };
    }
    const passwordUnchanged = async (email: string) => expect((await loginSeller(db, { email, password: PASSWORD }, {})).ok).toBe(true);

    it("그사이 대표자가 아니게 되면 거부", async () => {
      const { owner, grantToken } = await issued();
      await db.sellerUser.update({ where: { id: owner.id }, data: { isOwner: false } });
      expect(await resetSellerPassword(db, { grantToken, newPassword: NEW_PASSWORD })).toEqual({ ok: false, reason: "invalid_grant" });
      await db.sellerUser.update({ where: { id: owner.id }, data: { isOwner: true } });
      await passwordUnchanged(owner.email);
      expect((await db.auditLog.findFirstOrThrow({ where: { action: "auth.seller.password_reset.failed", reason: "not_owner" } })).actorId).toBe(owner.id);
    });

    it("그사이 계정이 비활성화되면 거부", async () => {
      const { owner, grantToken } = await issued();
      await db.sellerUser.update({ where: { id: owner.id }, data: { status: "DISABLED" } });
      expect(await resetSellerPassword(db, { grantToken, newPassword: NEW_PASSWORD })).toEqual({ ok: false, reason: "invalid_grant" });
      expect(await db.auditLog.count({ where: { action: "auth.seller.password_reset.failed", reason: "account_disabled" } })).toBe(1);
    });

    it("그사이 쇼핑몰 대표자 CI가 바뀌면 거부, 권한은 다시 쓸 수 없다", async () => {
      const { seller, owner, grantToken } = await issued();
      await db.seller.update({ where: { id: seller.id }, data: { representativeCiHash: hashCi("NEW-REP") } });
      expect(await resetSellerPassword(db, { grantToken, newPassword: NEW_PASSWORD })).toEqual({ ok: false, reason: "invalid_grant" });
      await db.seller.update({ where: { id: seller.id }, data: { representativeCiHash: hashCi("REP-CI") } });
      expect(await resetSellerPassword(db, { grantToken, newPassword: NEW_PASSWORD })).toEqual({ ok: false, reason: "invalid_grant" });
      await passwordUnchanged(owner.email);
    });

    it("재설정에 성공하면 같은 계정의 다른 미사용 권한은 모두 무효", async () => {
      const { seller, owner } = await shop();
      const first = await grantFor(owner.email, seller.slug, "REP-CI");
      const second = await grantFor(owner.email, seller.slug, "REP-CI");
      if (!first.grant.ok || !second.grant.ok) throw new Error("grant failed");
      expect(await resetSellerPassword(db, { grantToken: first.grant.grantToken, newPassword: NEW_PASSWORD })).toEqual({ ok: true });
      expect(await resetSellerPassword(db, { grantToken: second.grant.grantToken, newPassword: "another-pass-1" })).toEqual({
        ok: false,
        reason: "invalid_grant",
      });
      expect((await loginSeller(db, { email: owner.email, password: NEW_PASSWORD }, {})).ok).toBe(true);
    });
  });

  it("CI가 대표자와 다르면 거부하고 실패를 감사 로그에 남긴다", async () => {
    const { seller, owner } = await shop();
    const { grant } = await grantFor(owner.email, seller.slug, "SOMEONE-ELSE");
    expect(grant).toEqual({ ok: false, reason: "reset_not_allowed" });
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "auth.seller.password_reset.failed" } })).reason).toBe("ci_mismatch");
    expect(await db.passwordResetGrant.count()).toBe(0);
  });

  it("직원 계정은 대표자 CI로 인증해도 거부", async () => {
    const { seller, manager } = await shop();
    const { grant } = await grantFor(manager.email, seller.slug, "REP-CI");
    expect(grant).toEqual({ ok: false, reason: "reset_not_allowed" });
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "auth.seller.password_reset.failed" } })).reason).toBe("not_owner");
  });

  it("없는 계정도 시작 응답 모양이 같고, 결과는 같은 거부", async () => {
    const { seller, owner } = await shop();
    const real = await startOk({ email: owner.email, shopSlug: seller.slug });
    const fake = await startOk({ email: "nobody@example.com", shopSlug: seller.slug });
    const noShop = await startOk({ email: owner.email, shopSlug: "no-such-shop" });
    expect(Object.keys(fake).sort()).toEqual(Object.keys(real).sort());
    expect(Object.keys(noShop).sort()).toEqual(Object.keys(real).sort());
    provider.complete(fake.requestId, person("REP-CI"));
    expect(await issueSellerPasswordResetGrant(db, provider, { verificationId: fake.verificationId, ownerToken: fake.ownerToken })).toEqual({
      ok: false,
      reason: "reset_not_allowed",
    });
  });

  it("재설정 권한은 한 번만 쓸 수 있다", async () => {
    const { seller, owner } = await shop();
    const { grant } = await grantFor(owner.email, seller.slug, "REP-CI");
    if (!grant.ok) throw new Error("grant failed");
    expect(await resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: NEW_PASSWORD })).toEqual({ ok: true });
    expect(await resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: "another-pass-1" })).toEqual({
      ok: false,
      reason: "invalid_grant",
    });
  });

  it("동시에 두 번 써도 한 번만 성공", async () => {
    const { seller, owner } = await shop();
    const { grant } = await grantFor(owner.email, seller.slug, "REP-CI");
    if (!grant.ok) throw new Error("grant failed");
    const results = await Promise.all([
      resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: "first-pass-1" }),
      resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: "second-pass-1" }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("같은 본인인증으로 재설정 권한을 두 번 받을 수 없다", async () => {
    const { seller, owner } = await shop();
    const { start, grant } = await grantFor(owner.email, seller.slug, "REP-CI");
    expect(grant.ok).toBe(true);
    expect(await issueSellerPasswordResetGrant(db, provider, { verificationId: start.verificationId, ownerToken: start.ownerToken })).toEqual({
      ok: false,
      reason: "reset_not_allowed",
    });
  });

  it("10분이 지난 재설정 권한은 쓸 수 없다", async () => {
    const { seller, owner } = await shop();
    const t0 = new Date();
    const { grant } = await grantFor(owner.email, seller.slug, "REP-CI", t0);
    if (!grant.ok) throw new Error("grant failed");
    expect(
      await resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: NEW_PASSWORD }, { now: new Date(t0.getTime() + 10 * 60_000 + 1) }),
    ).toEqual({ ok: false, reason: "invalid_grant" });
  });

  it("시작한 브라우저가 아니면(소유 값 불일치) 거부", async () => {
    const { seller, owner } = await shop();
    const s = await startOk({ email: owner.email, shopSlug: seller.slug });
    provider.complete(s.requestId, person("REP-CI"));
    expect(await issueSellerPasswordResetGrant(db, provider, { verificationId: s.verificationId, ownerToken: "stolen" })).toEqual({
      ok: false,
      reason: "reset_not_allowed",
    });
  });

  it("PASS를 아직 마치지 않았으면 대기", async () => {
    const { seller, owner } = await shop();
    const s = await startOk({ email: owner.email, shopSlug: seller.slug });
    expect(await issueSellerPasswordResetGrant(db, provider, { verificationId: s.verificationId, ownerToken: s.ownerToken })).toEqual({
      ok: false,
      reason: "pending",
    });
  });

  it("무효한 재설정 권한이면 새 비밀번호 해시를 계산하지 않는다", async () => {
    const { seller, owner } = await shop();
    const { grant } = await grantFor(owner.email, seller.slug, "REP-CI");
    if (!grant.ok) throw new Error("grant failed");
    expect(await resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: NEW_PASSWORD })).toEqual({ ok: true });
    const spy = vi.spyOn(passwordHasher, "hashPassword");
    try {
      expect(await resetSellerPassword(db, { grantToken: "not-a-grant", newPassword: NEW_PASSWORD })).toEqual({ ok: false, reason: "invalid_grant" });
      expect(await resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: NEW_PASSWORD })).toEqual({ ok: false, reason: "invalid_grant" });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("짧은 비밀번호(8자 미만)는 거부", async () => {
    const { seller, owner } = await shop();
    const { grant } = await grantFor(owner.email, seller.slug, "REP-CI");
    if (!grant.ok) throw new Error("grant failed");
    expect(await resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: "short" })).toEqual({ ok: false, reason: "weak_password" });
  });
});

describe("비밀번호 찾기 시작 횟수 (쇼핑몰당 하루 10회, KST 자정 초기화)", () => {
  it("10회까지는 시작되고 11회째는 거부, 감사 로그를 남긴다", async () => {
    const { seller, owner } = await shop();
    for (let i = 0; i < 10; i++) {
      expect((await startSellerPasswordReset(db, provider, { email: owner.email, shopSlug: seller.slug })).ok).toBe(true);
    }
    expect(await startSellerPasswordReset(db, provider, { email: "other@example.com", shopSlug: seller.slug })).toEqual({
      ok: false,
      reason: "reset_limit_exceeded",
    });
    expect(await db.identityVerification.count({ where: { sellerId: seller.id } })).toBe(10);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "auth.seller.password_reset.limited" } })).toMatchObject({
      sellerId: seller.id,
      reason: "reset_limit_exceeded",
    });
  });

  it("다른 쇼핑몰은 영향이 없다", async () => {
    const a = await shop("CI-A");
    const b = await shop("CI-B");
    for (let i = 0; i < 10; i++) await startSellerPasswordReset(db, provider, { email: a.owner.email, shopSlug: a.seller.slug });
    expect((await startSellerPasswordReset(db, provider, { email: a.owner.email, shopSlug: a.seller.slug })).ok).toBe(false);
    expect((await startSellerPasswordReset(db, provider, { email: b.owner.email, shopSlug: b.seller.slug })).ok).toBe(true);
  });

  it("동시에 몰려도 10회를 넘지 않는다", async () => {
    const { seller, owner } = await shop();
    const results = await Promise.all(
      Array.from({ length: 15 }, () => startSellerPasswordReset(db, provider, { email: owner.email, shopSlug: seller.slug })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(10);
    expect(await db.identityVerification.count({ where: { sellerId: seller.id } })).toBe(10);
  });

  it("어제(KST) 시작한 건은 세지 않는다", async () => {
    const { seller, owner } = await shop();
    const yesterday = new Date(Date.now() - 26 * 3_600_000);
    for (let i = 0; i < 10; i++) await startSellerPasswordReset(db, provider, { email: owner.email, shopSlug: seller.slug }, { now: yesterday });
    expect((await startSellerPasswordReset(db, provider, { email: owner.email, shopSlug: seller.slug })).ok).toBe(true);
  });

  it("HTTP: 11회째는 429 reset_limit_exceeded", async () => {
    const { seller, owner } = await shop();
    const BASE = "http://localhost:3000";
    const req = () =>
      new Request(BASE + "/api/seller/password-reset/start", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000", origin: BASE },
        body: JSON.stringify({ email: owner.email, shopSlug: seller.slug }),
      });
    for (let i = 0; i < 10; i++) expect((await httpStart(req())).status).toBe(200);
    const res = await httpStart(req());
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "reset_limit_exceeded" });
  });
});

describe("직원 비밀번호 재설정 (대표가 직원 관리에서)", () => {
  const ctxOf = (u: { id: string; sellerId: string; isOwner: boolean; permissions: TenantContext["permissions"] }): TenantContext => ({
    sellerId: u.sellerId,
    actorType: "SELLER_USER",
    actorId: u.id,
    isOwner: u.isOwner,
    permissions: u.permissions,
    readOnly: false,
  });

  it("대표는 자기 쇼핑몰 직원 비밀번호를 재설정하고, 직원 기존 로그인은 끊긴다", async () => {
    const { owner, manager } = await shop();
    const before = await loginSeller(db, { email: manager.email, password: PASSWORD }, {});
    if (!before.ok) throw new Error("login failed");
    expect(await resetStaffPassword(db, ctxOf(owner), { staffUserId: manager.id, newPassword: NEW_PASSWORD })).toEqual({ ok: true });
    expect(await resolveSellerSession(db, before.token)).toBeNull();
    expect((await loginSeller(db, { email: manager.email, password: NEW_PASSWORD }, {})).ok).toBe(true);
    expect(await db.auditLog.count({ where: { action: "seller.staff.password_reset", targetId: manager.id } })).toBe(1);
  });

  it("매니저는 할 수 없고(403), 다른 쇼핑몰 직원(404)·대표 계정(403)은 대상이 아니다", async () => {
    const a = await shop("CI-A");
    const b = await shop("CI-B");
    await expect(resetStaffPassword(db, ctxOf(a.manager), { staffUserId: a.manager.id, newPassword: NEW_PASSWORD })).rejects.toMatchObject({ status: 403 });
    await expect(resetStaffPassword(db, ctxOf(a.owner), { staffUserId: b.manager.id, newPassword: NEW_PASSWORD })).rejects.toMatchObject({ status: 404 });
    await expect(resetStaffPassword(db, ctxOf(a.owner), { staffUserId: a.owner.id, newPassword: NEW_PASSWORD })).rejects.toMatchObject({ status: 403 });
  });
});

describe("HTTP: 비밀번호 찾기 흐름", () => {
  const BASE = "http://localhost:3000";
  const post = (path: string, body: unknown, cookie?: string) =>
    new Request(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000", origin: BASE, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const cookieOf = (res: Response) => res.headers.get("set-cookie")?.split(";")[0] ?? "";

  it("시작 → PASS → 확인 → 새 비밀번호, 재설정 권한 재사용은 400", async () => {
    const { seller, owner } = await shop();
    const s = await httpStart(post("/api/seller/password-reset/start", { email: owner.email, shopSlug: seller.slug }));
    expect(s.status).toBe(200);
    expect(s.headers.get("set-cookie")).toMatch(/^lo_idv=.*Path=\/api\/seller\/password-reset.*HttpOnly/i);
    const { verificationId, requestId } = await s.json();
    (identityProvider() as FakeIdentityProvider).complete(requestId, person("REP-CI"));

    // id 형식이 틀리면 서버 오류가 아니라 같은 거부(400 reset_not_allowed)
    const badId = await httpVerify(post("/api/seller/password-reset/verify", { verificationId: "not-a-uuid" }, cookieOf(s)));
    expect(badId.status).toBe(400);
    expect(await badId.json()).toEqual({ error: "reset_not_allowed" });
    // 쿠키 없이(다른 브라우저) 확인하면 거부
    expect((await httpVerify(post("/api/seller/password-reset/verify", { verificationId }))).status).toBe(400);
    const v = await httpVerify(post("/api/seller/password-reset/verify", { verificationId }, cookieOf(s)));
    expect(v.status).toBe(200);
    const grantCookie = (v.headers.get("set-cookie") ?? "").split(/,(?=\s*lo_)/).map((c) => c.trim()).find((c) => c.startsWith("lo_pwreset="))!;
    const gc = grantCookie.split(";")[0];

    expect((await httpComplete(post("/api/seller/password-reset/complete", { newPassword: NEW_PASSWORD }, gc))).status).toBe(200);
    expect((await httpComplete(post("/api/seller/password-reset/complete", { newPassword: "again-pass-1" }, gc))).status).toBe(400);
    expect((await loginSeller(db, { email: owner.email, password: NEW_PASSWORD }, {})).ok).toBe(true);
  });
});
