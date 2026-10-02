import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loginAdmin, loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { confirmTotpEnrollment, startTotpEnrollment } from "../../lib/server/auth/mfaEnroll";
import { resolveAdminSession, resolveBuyerSession, resolveSellerSession } from "../../lib/server/auth/session";
import { totpCode } from "../../lib/server/auth/totp";
import { impersonateSeller, requireAdmin, requireAdminEnrollment, requireSeller } from "../../lib/server/authz/guards";
import { getOrder, listOrders } from "../../lib/server/orders/read";
import { assertWritable } from "../../lib/server/tenant/context";
import {
  PASSWORD,
  adminCredentials,
  createAdmin,
  createBuyer,
  createLoginBuyer,
  createPaidOrderItem,
  createSeller,
  createSellerUser,
  db,
  resetDb,
} from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const t0 = new Date("2026-10-02T12:00:00Z");
const at = (minutes: number) => new Date(t0.getTime() + minutes * 60_000);

describe("마스터 로그인", () => {
  it("비밀번호와 2단계 인증 코드가 맞으면 세션이 생기고 감사 로그가 남는다", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const r = await loginAdmin(db, { ...(await adminCredentials(admin, t0)), email: admin.email.toUpperCase() }, { now: t0 });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.mfaEnrollmentRequired).toBeUndefined();
    const ctx = await resolveAdminSession(db, r.token, at(1));
    expect(ctx).toMatchObject({ enrollmentOnly: false });
    expect(ctx?.admin.id).toBe(admin.id);
    expect(await db.auditLog.count({ where: { action: "auth.admin.login", actorId: admin.id } })).toBe(1);
    const session = await db.adminSession.findFirstOrThrow({ where: { adminId: admin.id } });
    expect(session.tokenHash).not.toBe(r.token);
  });

  it("5번 틀리면 10분 잠기고, 잠긴 동안은 맞는 값도 거부, 10분 뒤 풀린다", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const reasons = [];
    for (let i = 0; i < 5; i++) {
      const r = await loginAdmin(db, { ...(await adminCredentials(admin, t0)), password: "wrong" }, { now: t0 });
      reasons.push(r.ok ? "ok" : r.reason);
    }
    expect(reasons).toEqual(["invalid_credentials", "invalid_credentials", "invalid_credentials", "invalid_credentials", "locked"]);
    expect(await loginAdmin(db, await adminCredentials(admin, at(9)), { now: at(9) })).toEqual({ ok: false, reason: "locked" });
    expect((await loginAdmin(db, await adminCredentials(admin, at(10)), { now: at(10) })).ok).toBe(true);
    expect(await db.auditLog.count({ where: { action: "auth.admin.locked" } })).toBe(1);
  });

  it("코드가 없거나 틀리면 비밀번호가 맞아도 같은 실패 응답이고, 실패 횟수에 들어간다", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const noCode = await loginAdmin(db, { email: admin.email, password: PASSWORD }, { now: t0 });
    const wrongCode = await loginAdmin(db, { email: admin.email, password: PASSWORD, totpCode: totpCode(admin.totpSecret, at(10)) }, { now: t0 });
    const wrongPassword = await loginAdmin(db, { email: admin.email, password: "x", totpCode: totpCode(admin.totpSecret, t0) }, { now: t0 });
    expect([noCode, wrongCode, wrongPassword]).toEqual(Array(3).fill({ ok: false, reason: "invalid_credentials" }));
    expect((await db.platformAdmin.findUniqueOrThrow({ where: { id: admin.id } })).failedLoginCount).toBe(3);
  });

  it("한 번 쓴 TOTP 코드는 다시 쓸 수 없다 (같은 30초 안·앞뒤 허용 범위 포함)", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const creds = await adminCredentials(admin, t0);
    expect((await loginAdmin(db, creds, { now: t0 })).ok).toBe(true);
    expect(await loginAdmin(db, creds, { now: new Date(t0.getTime() + 20_000) })).toEqual({ ok: false, reason: "invalid_credentials" });
    // 앞 스텝 코드(이미 지난 카운터)도 거부
    const prevStep = totpCode(admin.totpSecret, new Date(t0.getTime() - 30_000));
    expect(await loginAdmin(db, { ...creds, totpCode: prevStep }, { now: t0 })).toEqual({ ok: false, reason: "invalid_credentials" });
    // 다음 스텝의 새 코드는 통과
    expect((await loginAdmin(db, await adminCredentials(admin, at(1)), { now: at(1) })).ok).toBe(true);
  });

  it("같은 코드로 동시에 두 번 로그인해도 한 번만 통과", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const creds = await adminCredentials(admin, t0);
    const results = await Promise.all([loginAdmin(db, creds, { now: t0 }), loginAdmin(db, creds, { now: t0 })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("정지된 마스터는 로그인할 수 없다", async () => {
    const admin = await createAdmin("OPERATIONS", { status: "SUSPENDED" });
    expect(await loginAdmin(db, await adminCredentials(admin, t0), { now: t0 })).toEqual({ ok: false, reason: "account_disabled" });
  });

  it("없는 계정은 비밀번호 오류와 같은 응답", async () => {
    expect(await loginAdmin(db, { email: "nobody@example.com", password: PASSWORD, totpCode: "123456" }, { now: t0 })).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
  });

  it("미활동 30분이 지나면 세션이 끝난다", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const r = await loginAdmin(db, await adminCredentials(admin, t0), { now: t0 });
    if (!r.ok) throw new Error("login failed");
    expect(await resolveAdminSession(db, r.token, at(29))).not.toBeNull();
    expect(await resolveAdminSession(db, r.token, at(29 + 30))).toBeNull();
  });
});

describe("마스터 TOTP 등록 강제", () => {
  it("등록 전 계정은 등록 전용 세션만 받고, 등록 API 말고는 모두 거부된다", async () => {
    const admin = await createAdmin("SUPER_ADMIN", { enrolled: false });
    const r = await loginAdmin(db, { email: admin.email, password: PASSWORD }, { now: t0 });
    expect(r).toMatchObject({ ok: true, mfaEnrollmentRequired: true });
    if (!r.ok) return;
    await expect(requireAdmin(db, r.token, "platform.read", at(1))).rejects.toMatchObject({ status: 403, code: "mfa_enrollment_required" });
    await expect(requireAdminEnrollment(db, r.token, at(1))).resolves.toMatchObject({ enrollmentOnly: true });
  });

  it("등록을 마치면 같은 세션으로 마스터 기능을 쓸 수 있고, 다음 로그인부터 코드가 필요하다", async () => {
    const admin = await createAdmin("SUPER_ADMIN", { enrolled: false });
    const r = await loginAdmin(db, { email: admin.email, password: PASSWORD }, { now: t0 });
    if (!r.ok) throw new Error("login failed");
    const ctx = await requireAdminEnrollment(db, r.token, at(1));
    const { secret, otpauthUri } = await startTotpEnrollment(db, ctx);
    expect(otpauthUri).toContain(`secret=${secret}`);
    expect(await confirmTotpEnrollment(db, ctx, "000000", { now: at(1) })).toMatchObject({ ok: false });
    expect(await confirmTotpEnrollment(db, ctx, totpCode(secret, at(1)), { now: at(1) })).toEqual({ ok: true });
    await expect(requireAdmin(db, r.token, "admin.manage", at(2))).resolves.toBeTruthy();
    await expect(requireAdminEnrollment(db, r.token, at(2))).rejects.toMatchObject({ status: 403 });
    // 등록에 쓴 코드는 다시 못 쓰고, 다음 로그인은 새 코드가 필요
    expect(await loginAdmin(db, { email: admin.email, password: PASSWORD }, { now: at(3) })).toEqual({ ok: false, reason: "invalid_credentials" });
    expect((await loginAdmin(db, { email: admin.email, password: PASSWORD, totpCode: totpCode(secret, at(3)) }, { now: at(3) })).ok).toBe(true);
    expect(await db.auditLog.count({ where: { action: "admin.mfa.enroll", actorId: admin.id } })).toBe(1);
  });

  it("등록을 마친 마스터 세션으로는 등록 API를 다시 쓸 수 없다", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const r = await loginAdmin(db, await adminCredentials(admin, t0), { now: t0 });
    if (!r.ok) throw new Error("login failed");
    await expect(requireAdminEnrollment(db, r.token, at(1))).rejects.toMatchObject({ status: 403 });
  });
});

describe("마스터 역할별 권한", () => {
  async function adminToken(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
    const admin = await createAdmin(role);
    const r = await loginAdmin(db, await adminCredentials(admin, t0), { now: t0 });
    if (!r.ok) throw new Error("login failed");
    return r.token;
  }

  it("조회 전용은 조회는 되고 판매자 정지·관리자 계정 변경은 403", async () => {
    const token = await adminToken("READ_ONLY");
    await expect(requireAdmin(db, token, "platform.read", at(1))).resolves.toBeTruthy();
    await expect(requireAdmin(db, token, "seller.moderate", at(1))).rejects.toMatchObject({ status: 403 });
    await expect(requireAdmin(db, token, "admin.manage", at(1))).rejects.toMatchObject({ status: 403 });
  });

  it("운영은 판매자 정지 가능, 관리자 계정 변경은 403", async () => {
    const token = await adminToken("OPERATIONS");
    await expect(requireAdmin(db, token, "seller.moderate", at(1))).resolves.toBeTruthy();
    await expect(requireAdmin(db, token, "admin.manage", at(1))).rejects.toMatchObject({ status: 403 });
  });

  it("CS는 문의 답변 가능, 판매자 정지는 403", async () => {
    const token = await adminToken("CS");
    await expect(requireAdmin(db, token, "support.manage", at(1))).resolves.toBeTruthy();
    await expect(requireAdmin(db, token, "seller.moderate", at(1))).rejects.toMatchObject({ status: 403 });
  });

  it("최고관리자는 관리자 계정·시스템 설정 가능", async () => {
    const token = await adminToken("SUPER_ADMIN");
    await expect(requireAdmin(db, token, "admin.manage", at(1))).resolves.toBeTruthy();
    await expect(requireAdmin(db, token, "system.manage", at(1))).resolves.toBeTruthy();
  });
});

describe("로그인 잠금: 동시 요청·IP 기준", () => {
  const ip = (n: number) => ({ ip: `203.0.113.${n}`, now: t0 });

  it("틀린 비밀번호로 동시에 20번 시도해도 계정이 잠긴다 (구매자·판매자·마스터)", async () => {
    const { seller, grade } = await createSeller();
    const m = await createLoginBuyer(seller.id, grade.id);
    const staff = await createSellerUser(seller.id, "MANAGER");
    const admin = await createAdmin("SUPER_ADMIN");
    await Promise.all(Array.from({ length: 20 }, () => loginBuyer(db, { sellerId: seller.id, loginId: m.loginId, password: "x" }, { now: t0 })));
    await Promise.all(Array.from({ length: 20 }, () => loginSeller(db, { email: staff.email, password: "x" }, { now: t0 })));
    await Promise.all(Array.from({ length: 20 }, () => loginAdmin(db, { email: admin.email, password: "x" }, { now: t0 })));
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: m.id } })).lockedUntil).not.toBeNull();
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: staff.id } })).lockedUntil).not.toBeNull();
    expect((await db.platformAdmin.findUniqueOrThrow({ where: { id: admin.id } })).lockedUntil).not.toBeNull();
    expect(await loginBuyer(db, { sellerId: seller.id, loginId: m.loginId, password: PASSWORD }, { now: at(1) })).toEqual({ ok: false, reason: "locked" });
    expect(await loginSeller(db, { email: staff.email, password: PASSWORD }, { now: at(1) })).toEqual({ ok: false, reason: "locked" });
  });

  it("같은 IP에서 여러 계정으로 20번 틀리면 그 IP는 10분 막히고, 다른 IP는 영향 없다", async () => {
    const { seller, grade } = await createSeller();
    const members = await Promise.all(Array.from({ length: 5 }, () => createLoginBuyer(seller.id, grade.id)));
    let last;
    for (let i = 0; i < 20; i++) {
      // 계정마다 4번씩만 틀려 계정 잠금(5회)에는 걸리지 않게 한다
      last = await loginBuyer(db, { sellerId: seller.id, loginId: members[i % 5].loginId, password: "x" }, ip(1));
    }
    expect(last).toEqual({ ok: false, reason: "locked" });
    // 막힌 IP에서는 맞는 비밀번호도 거부
    expect(await loginBuyer(db, { sellerId: seller.id, loginId: members[0].loginId, password: PASSWORD }, { ...ip(1), now: at(9) })).toEqual({
      ok: false,
      reason: "locked",
    });
    expect((await loginBuyer(db, { sellerId: seller.id, loginId: members[0].loginId, password: PASSWORD }, ip(2))).ok).toBe(true);
    expect((await loginBuyer(db, { sellerId: seller.id, loginId: members[1].loginId, password: PASSWORD }, { ...ip(1), now: at(10) })).ok).toBe(true);
  });

  it("없는 계정으로 틀려도 IP 기준으로 센다", async () => {
    for (let i = 0; i < 19; i++) await loginAdmin(db, { email: `none${i}@example.com`, password: "x" }, ip(3));
    expect(await loginAdmin(db, { email: "none@example.com", password: "x" }, ip(3))).toEqual({ ok: false, reason: "locked" });
  });

  it("쇼핑몰을 고르지 않은 판매자 로그인 실패는 계정에 기록하지 않는다 (같은 이메일 여러 쇼핑몰)", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const ua = await createSellerUser(a.seller.id, "OWNER", "multi@example.com");
    const ub = await createSellerUser(b.seller.id, "OWNER", "multi@example.com");
    for (let i = 0; i < 6; i++) await loginSeller(db, { email: "multi@example.com", password: "x" }, { now: t0 });
    const rows = await db.sellerUser.findMany({ where: { id: { in: [ua.id, ub.id] } } });
    expect(rows.map((u) => [u.failedLoginCount, u.lockedUntil])).toEqual([
      [0, null],
      [0, null],
    ]);
    // 쇼핑몰을 고른 실패는 그 계정에만 기록
    await loginSeller(db, { email: "multi@example.com", password: "x", shopSlug: a.seller.slug }, { now: t0 });
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: ua.id } })).failedLoginCount).toBe(1);
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: ub.id } })).failedLoginCount).toBe(0);
  });

  it("감사 로그의 IP는 신뢰한 접속 IP로 남는다", async () => {
    await loginAdmin(db, { email: "nobody@example.com", password: "x" }, ip(7));
    expect((await db.auditLog.findFirstOrThrow({ where: { action: "auth.admin.login_failed" } })).ip).toBe("203.0.113.7");
  });
});

describe("판매자 로그인과 마스터 기능 차단", () => {
  it("판매자 세션으로는 마스터 API에 접근할 수 없다 (401)", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, { now: t0 });
    if (!r.ok) throw new Error("login failed");
    await expect(requireSeller(db, r.token, at(1))).resolves.toMatchObject({ sellerId: seller.id, sellerRole: "OWNER" });
    await expect(requireAdmin(db, r.token, "platform.read", at(1))).rejects.toMatchObject({ status: 401 });
  });

  it("승인 대기·정지된 판매자는 로그인할 수 없다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    await db.seller.update({ where: { id: seller.id }, data: { status: "PENDING" } });
    expect(await loginSeller(db, { email: owner.email, password: PASSWORD }, { now: t0 })).toEqual({ ok: false, reason: "seller_pending" });
    await db.seller.update({ where: { id: seller.id }, data: { status: "SUSPENDED" } });
    expect(await loginSeller(db, { email: owner.email, password: PASSWORD }, { now: t0 })).toEqual({ ok: false, reason: "seller_suspended" });
  });

  it("판매자가 정지되면 기존 세션도 바로 끊긴다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, { now: t0 });
    if (!r.ok) throw new Error("login failed");
    await db.seller.update({ where: { id: seller.id }, data: { status: "SUSPENDED" } });
    await expect(requireSeller(db, r.token, at(1))).rejects.toMatchObject({ status: 401 });
  });

  it("같은 이메일이 두 판매자에 있으면 비밀번호가 맞는 계정으로, 둘 다 맞으면 쇼핑몰을 고르게 한다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    await createSellerUser(a.seller.id, "OWNER", "same@example.com");
    await createSellerUser(b.seller.id, "MANAGER", "same@example.com");
    expect(await loginSeller(db, { email: "same@example.com", password: PASSWORD }, { now: t0 })).toEqual({
      ok: false,
      reason: "shop_required",
    });
    const r = await loginSeller(db, { email: "same@example.com", password: PASSWORD, shopSlug: b.seller.slug }, { now: t0 });
    if (!r.ok) throw new Error("login failed");
    expect((await requireSeller(db, r.token, at(1))).sellerId).toBe(b.seller.id);
  });

  it("방송 LIVE 중에는 미활동 로그아웃이 없고, 종료 30분 뒤부터 다시 센다", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "BROADCASTER");
    const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, { now: t0 });
    if (!r.ok) throw new Error("login failed");
    const b = await db.broadcastSession.create({ data: { sellerId: seller.id, startedAt: t0 } });
    expect(await resolveSellerSession(db, r.token, at(13 * 60))).not.toBeNull();
    await db.broadcastSession.update({ where: { id: b.id }, data: { status: "ENDED", endedAt: at(14 * 60) } });
    // 조회는 마지막 활동 시각을 갱신하므로 만료 직전 확인은 단위 테스트(policy.test.ts)에서 한다.
    expect(await resolveSellerSession(db, r.token, at(14 * 60 + 30 + 12 * 60))).toBeNull();
  });
});

describe("구매자 로그인 (쇼핑몰별)", () => {
  it("자기 쇼핑몰 세션만 인정하고 다른 쇼핑몰에서는 거부", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const m = await createLoginBuyer(a.seller.id, a.grade.id);
    expect(await loginBuyer(db, { sellerId: b.seller.id, loginId: m.loginId, password: PASSWORD }, { now: t0 })).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
    const r = await loginBuyer(db, { sellerId: a.seller.id, loginId: m.loginId, password: PASSWORD }, { now: t0 });
    if (!r.ok) throw new Error("login failed");
    expect((await resolveBuyerSession(db, r.token, a.seller.id, at(1)))?.member.id).toBe(m.id);
    expect(await resolveBuyerSession(db, r.token, b.seller.id, at(1))).toBeNull();
  });

  it("5번 틀리면 잠기고, 탈퇴 회원은 로그인할 수 없다", async () => {
    const { seller, grade } = await createSeller();
    const m = await createLoginBuyer(seller.id, grade.id);
    let last;
    for (let i = 0; i < 5; i++) last = await loginBuyer(db, { sellerId: seller.id, loginId: m.loginId, password: "x" }, { now: t0 });
    expect(last).toEqual({ ok: false, reason: "locked" });
    await db.buyerMember.update({ where: { id: m.id }, data: { status: "WITHDRAWN", deletedAt: t0 } });
    expect(await loginBuyer(db, { sellerId: seller.id, loginId: m.loginId, password: PASSWORD }, { now: at(20) })).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
  });
});

describe("테넌트 격리 (판매자 범위 조회)", () => {
  async function setup() {
    const a = await createSeller();
    const b = await createSeller();
    const buyerA = await createBuyer(a.seller.id, a.grade.id);
    const { order } = await createPaidOrderItem(a.seller.id, buyerA.id);
    const managerB = await createSellerUser(b.seller.id, "MANAGER");
    const r = await loginSeller(db, { email: managerB.email, password: PASSWORD }, { now: t0 });
    if (!r.ok) throw new Error("login failed");
    const ctxB = await requireSeller(db, r.token, at(1));
    return { a, b, order, ctxB };
  }

  it("다른 판매자의 주문을 id로 조회하면 404", async () => {
    const { order, ctxB } = await setup();
    await expect(getOrder(db, ctxB, order.id)).rejects.toMatchObject({ status: 404 });
  });

  it("목록에는 자기 쇼핑몰 주문만 나온다", async () => {
    const { ctxB } = await setup();
    expect(await listOrders(db, ctxB)).toEqual([]);
  });

  it("방송 담당 직원은 주문을 볼 수 없다 (403)", async () => {
    const { a, order } = await setup();
    const caster = await createSellerUser(a.seller.id, "BROADCASTER");
    const r = await loginSeller(db, { email: caster.email, password: PASSWORD }, { now: t0 });
    if (!r.ok) throw new Error("login failed");
    const ctx = await requireSeller(db, r.token, at(1));
    await expect(getOrder(db, ctx, order.id)).rejects.toMatchObject({ status: 403 });
  });
});

describe("마스터 대리 조회", () => {
  it("읽기 전용으로 판매자 주문을 보고, 변경은 거부, 사유와 함께 감사 로그를 남긴다", async () => {
    const { seller, grade } = await createSeller();
    const buyer = await createBuyer(seller.id, grade.id);
    const { order } = await createPaidOrderItem(seller.id, buyer.id);
    const admin = await createAdmin("CS");
    const r = await loginAdmin(db, await adminCredentials(admin, t0), { now: t0 });
    if (!r.ok) throw new Error("login failed");
    const adminCtx = await requireAdmin(db, r.token, "platform.read", at(1));
    const ctx = await impersonateSeller(db, adminCtx, seller.id, "문의 확인");
    expect((await getOrder(db, ctx, order.id)).id).toBe(order.id);
    expect(() => assertWritable(ctx)).toThrow("forbidden");
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "admin.impersonate.view" } });
    expect(log).toMatchObject({ actorId: admin.id, sellerId: seller.id, reason: "문의 확인" });
  });

  it("조회 전용 관리자는 대리 조회를 할 수 없고, 사유가 없으면 거부", async () => {
    const { seller } = await createSeller();
    const ro = await createAdmin("READ_ONLY");
    const ops = await createAdmin("OPERATIONS");
    const ctxOf = async (admin: { email: string; totpSecret: string }) => {
      const r = await loginAdmin(db, await adminCredentials(admin, t0), { now: t0 });
      if (!r.ok) throw new Error("login failed");
      return requireAdmin(db, r.token, "platform.read", at(1));
    };
    await expect(impersonateSeller(db, await ctxOf(ro), seller.id, "확인")).rejects.toMatchObject({ status: 403 });
    await expect(impersonateSeller(db, await ctxOf(ops), seller.id, "  ")).rejects.toMatchObject({ status: 403 });
  });
});
