import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as httpComplete } from "../../app/api/seller/password-reset/complete/route";
import { POST as httpStart } from "../../app/api/seller/password-reset/start/route";
import { POST as httpVerify } from "../../app/api/seller/password-reset/verify/route";
import { loginSeller } from "../../lib/server/auth/login";
import { issueSellerPasswordResetGrant, resetSellerPassword, resetStaffPassword, startSellerPasswordReset } from "../../lib/server/auth/passwordReset";
import { resolveSellerSession } from "../../lib/server/auth/session";
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
  const s = await startSellerPasswordReset(db, provider, { email, shopSlug }, { now });
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
    const real = await startSellerPasswordReset(db, provider, { email: owner.email, shopSlug: seller.slug });
    const fake = await startSellerPasswordReset(db, provider, { email: "nobody@example.com", shopSlug: seller.slug });
    const noShop = await startSellerPasswordReset(db, provider, { email: owner.email, shopSlug: "no-such-shop" });
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
    const s = await startSellerPasswordReset(db, provider, { email: owner.email, shopSlug: seller.slug });
    provider.complete(s.requestId, person("REP-CI"));
    expect(await issueSellerPasswordResetGrant(db, provider, { verificationId: s.verificationId, ownerToken: "stolen" })).toEqual({
      ok: false,
      reason: "reset_not_allowed",
    });
  });

  it("PASS를 아직 마치지 않았으면 대기", async () => {
    const { seller, owner } = await shop();
    const s = await startSellerPasswordReset(db, provider, { email: owner.email, shopSlug: seller.slug });
    expect(await issueSellerPasswordResetGrant(db, provider, { verificationId: s.verificationId, ownerToken: s.ownerToken })).toEqual({
      ok: false,
      reason: "pending",
    });
  });

  it("짧은 비밀번호(8자 미만)는 거부", async () => {
    const { seller, owner } = await shop();
    const { grant } = await grantFor(owner.email, seller.slug, "REP-CI");
    if (!grant.ok) throw new Error("grant failed");
    expect(await resetSellerPassword(db, { grantToken: grant.grantToken, newPassword: "short" })).toEqual({ ok: false, reason: "weak_password" });
  });
});

describe("직원 비밀번호 재설정 (대표가 직원 관리에서)", () => {
  const ctxOf = (u: { id: string; sellerId: string; role: "OWNER" | "MANAGER" | "BROADCASTER" }): TenantContext => ({
    sellerId: u.sellerId,
    actorType: "SELLER_USER",
    actorId: u.id,
    sellerRole: u.role,
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
