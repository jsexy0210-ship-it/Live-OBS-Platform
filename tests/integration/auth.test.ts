import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loginAdmin, loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { resolveAdminSession, resolveBuyerSession, resolveSellerSession } from "../../lib/server/auth/session";
import { impersonateSeller, requireAdmin, requireSeller } from "../../lib/server/authz/guards";
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

describe("마스터 로그인 (이메일+비밀번호, 2단계 인증 없음)", () => {
  it("이메일과 비밀번호만으로 로그인되고 세션과 감사 로그가 남는다", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const r = await loginAdmin(db, { email: admin.email.toUpperCase(), password: PASSWORD }, { now: t0 });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    const ctx = await requireAdmin(db, r.token, "admin.manage", at(1));
    expect(ctx.admin.id).toBe(admin.id);
    expect(await db.auditLog.count({ where: { action: "auth.admin.login", actorId: admin.id } })).toBe(1);
    const session = await db.adminSession.findFirstOrThrow({ where: { adminId: admin.id } });
    expect(session.tokenHash).not.toBe(r.token);
  });

  it("틀린 비밀번호는 거부하고 감사 로그에 남긴다", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    expect(await loginAdmin(db, { email: admin.email, password: "wrong" }, { ip: "203.0.113.5", now: t0 })).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "auth.admin.login_failed" } })).toMatchObject({
      actorId: admin.id,
      reason: "wrong_password",
      ip: "203.0.113.5",
    });
  });

  it("정지된 마스터는 로그인할 수 없다", async () => {
    const admin = await createAdmin("OPERATIONS", { status: "SUSPENDED" });
    expect(await loginAdmin(db, adminCredentials(admin), { now: t0 })).toEqual({ ok: false, reason: "account_disabled" });
  });

  it("없는 계정은 비밀번호 오류와 같은 응답", async () => {
    expect(await loginAdmin(db, { email: "nobody@example.com", password: PASSWORD }, { now: t0 })).toEqual({
      ok: false,
      reason: "invalid_credentials",
    });
  });

  it("미활동 30분이 지나면 세션이 끝나고, 계속 활동해도 최대 8시간", async () => {
    const admin = await createAdmin("SUPER_ADMIN");
    const r = await loginAdmin(db, adminCredentials(admin), { now: t0 });
    if (!r.ok) throw new Error("login failed");
    expect(await resolveAdminSession(db, r.token, at(29))).not.toBeNull();
    expect(await resolveAdminSession(db, r.token, at(29 + 30))).toBeNull();
  });
});

describe("로그인 실패 잠금 없음 (대표님 결정 2026-10-02)", () => {
  it("여러 번 틀려도 잠기지 않고, 맞는 비밀번호로 바로 로그인된다 (마스터·판매자·구매자)", async () => {
    const { seller, grade } = await createSeller();
    const m = await createLoginBuyer(seller.id, grade.id);
    const staff = await createSellerUser(seller.id, "MANAGER");
    const admin = await createAdmin("SUPER_ADMIN");
    await Promise.all(Array.from({ length: 20 }, () => loginBuyer(db, { sellerId: seller.id, loginId: m.loginId, password: "x" }, { now: t0 })));
    await Promise.all(Array.from({ length: 20 }, () => loginSeller(db, { email: staff.email, password: "x" }, { now: t0 })));
    await Promise.all(Array.from({ length: 20 }, () => loginAdmin(db, { email: admin.email, password: "x" }, { now: t0 })));
    expect((await loginBuyer(db, { sellerId: seller.id, loginId: m.loginId, password: PASSWORD }, { now: t0 })).ok).toBe(true);
    expect((await loginSeller(db, { email: staff.email, password: PASSWORD }, { now: t0 })).ok).toBe(true);
    expect((await loginAdmin(db, adminCredentials(admin), { now: t0 })).ok).toBe(true);
    expect(await db.auditLog.count({ where: { action: { endsWith: "login_failed" } } })).toBe(60);
  });

  it("쇼핑몰을 고르지 않은 판매자 로그인 실패는 계정 없이 기록되고, 고른 실패는 그 계정으로 기록된다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const ua = await createSellerUser(a.seller.id, "OWNER", "multi@example.com");
    await createSellerUser(b.seller.id, "OWNER", "multi@example.com");
    await loginSeller(db, { email: "multi@example.com", password: "x" }, { now: t0 });
    await loginSeller(db, { email: "multi@example.com", password: "x", shopSlug: a.seller.slug }, { now: t0 });
    const logs = await db.auditLog.findMany({ where: { action: "auth.seller.login_failed" }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => [l.actorId, l.reason])).toEqual([
      [null, "shop_unspecified"],
      [ua.id, "wrong_password"],
    ]);
  });
});

describe("마스터 역할별 권한", () => {
  async function adminToken(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
    const admin = await createAdmin(role);
    const r = await loginAdmin(db, adminCredentials(admin), { now: t0 });
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

describe("판매자 로그인과 마스터 기능 차단", () => {
  it("판매자 세션으로는 마스터 API에 접근할 수 없다 (401)", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, { now: t0 });
    if (!r.ok) throw new Error("login failed");
    await expect(requireSeller(db, r.token, at(1))).resolves.toMatchObject({ sellerId: seller.id, isOwner: true });
    await expect(requireAdmin(db, r.token, "platform.read", at(1))).rejects.toMatchObject({ status: 401 });
  });

  it("승인 대기 판매자는 로그인할 수 없고, 이용 정지된 판매자는 로그인된다(신규만 막기, 대표님 결정 2026-10-04)", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    await db.seller.update({ where: { id: seller.id }, data: { status: "PENDING" } });
    expect(await loginSeller(db, { email: owner.email, password: PASSWORD }, { now: t0 })).toEqual({ ok: false, reason: "seller_pending" });
    await db.seller.update({ where: { id: seller.id }, data: { status: "SUSPENDED" } });
    expect(await loginSeller(db, { email: owner.email, password: PASSWORD }, { now: t0 })).toMatchObject({ ok: true });
  });

  it("판매자가 정지되면 기존 세션은 살아 있지만, 이미 받은 주문 처리·내 정보 밖의 API는 바로 403 seller_suspended", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, { now: t0 });
    if (!r.ok) throw new Error("login failed");
    await db.seller.update({ where: { id: seller.id }, data: { status: "SUSPENDED" } });
    await expect(requireSeller(db, r.token, at(1))).rejects.toMatchObject({ status: 403, code: "seller_suspended" });
    await expect(requireSeller(db, r.token, at(1), { allowUnpaid: true, feature: "BILLING" })).rejects.toMatchObject({ status: 403, code: "seller_suspended" });
    await expect(requireSeller(db, r.token, at(1), { allowUnpaid: true, feature: "ORDER_FOLLOWUP" })).resolves.toMatchObject({ sellerId: seller.id });
    await expect(requireSeller(db, r.token, at(1), { allowUnpaid: true, feature: "BILLING", allowSuspended: true })).resolves.toMatchObject({ sellerId: seller.id });
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

  it("탈퇴 회원은 로그인할 수 없다", async () => {
    const { seller, grade } = await createSeller();
    const m = await createLoginBuyer(seller.id, grade.id);
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
    const r = await loginAdmin(db, adminCredentials(admin), { now: t0 });
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
    const ctxOf = async (admin: { email: string }) => {
      const r = await loginAdmin(db, adminCredentials(admin), { now: t0 });
      if (!r.ok) throw new Error("login failed");
      return requireAdmin(db, r.token, "platform.read", at(1));
    };
    await expect(impersonateSeller(db, await ctxOf(ro), seller.id, "확인")).rejects.toMatchObject({ status: 403 });
    await expect(impersonateSeller(db, await ctxOf(ops), seller.id, "  ")).rejects.toMatchObject({ status: 403 });
  });
});
