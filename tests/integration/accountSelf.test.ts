import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as adminPwRoute } from "../../app/api/admin/me/password/route";
import { POST as startImp } from "../../app/api/admin/sellers/[sellerId]/impersonate/route";
import { GET as meRoute } from "../../app/api/seller/me/route";
import { PATCH as nameRoute } from "../../app/api/seller/me/name/route";
import { POST as sellerPwRoute } from "../../app/api/seller/me/password/route";
import { changeAdminPassword, changeSellerPassword } from "../../lib/server/auth/account";
import { loginAdmin, loginSeller } from "../../lib/server/auth/login";
import { hashPassword } from "../../lib/server/auth/password";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 내 계정(SA-120·MA-090): 현재 비밀번호 확인, 새 비밀번호 검사, 다른 곳 로그아웃 여부(필수), 로그 추적(비밀번호 값 없음), 내 이름 바꾸기, 읽기 전용·격리.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const NEW_PW = "new-password-123";
const req = (path: string, cookie: string, method: string, body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const json = async (r: Response | Promise<Response>) => {
  const res = await r;
  return { status: res.status, body: await res.json() };
};
async function sellerLogin(email: string, password = PASSWORD) {
  const r = await loginSeller(db, { email, password }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shopOwner() {
  const { seller } = await createSeller();
  const user = await createSellerUser(seller.id, "OWNER");
  return { seller, user };
}
const pw = (cookie: string, body: unknown) => json(sellerPwRoute(req("/api/seller/me/password", cookie, "POST", body)));
const meStatus = async (cookie: string) => (await meRoute(req("/api/seller/me", cookie, "GET"))).status;

describe("파트너스 내 비밀번호 POST /api/seller/me/password", () => {
  it("현재 비밀번호가 맞아야 하고, 틀리면 400이며 비밀번호는 그대로·로그 추적에 실패만 남는다", async () => {
    const { user } = await shopOwner();
    const cookie = await sellerLogin(user.email);
    const r = await pw(cookie, { currentPassword: "틀린-비밀번호-1", newPassword: NEW_PW, signOutOthers: false });
    expect(r).toMatchObject({ status: 400, body: { error: "wrong_password", message: "현재 비밀번호가 맞지 않습니다" } });
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash);
    const logs = await db.auditLog.findMany({ where: { action: "auth.seller.password_change_failed" } });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).not.toContain(NEW_PW);
    expect(JSON.stringify(logs[0])).not.toContain("틀린-비밀번호-1");
  });

  it("입력 검사: 빠진 값·signOutOthers가 불리언이 아님 400 bad_request, 새 비밀번호 8자 미만·200자 초과 weak_password, 현재와 같으면 same_password", async () => {
    const { user } = await shopOwner();
    const cookie = await sellerLogin(user.email);
    for (const body of [{}, { currentPassword: PASSWORD, newPassword: NEW_PW }, { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: "true" }, { currentPassword: "", newPassword: NEW_PW, signOutOthers: true }, { currentPassword: PASSWORD, newPassword: 12345678, signOutOthers: true }]) {
      expect(await pw(cookie, body)).toMatchObject({ status: 400, body: { error: "bad_request" } });
    }
    expect((await pw(cookie, { currentPassword: PASSWORD, newPassword: "short", signOutOthers: true })).body.error).toBe("weak_password");
    expect((await pw(cookie, { currentPassword: PASSWORD, newPassword: "a".repeat(201), signOutOthers: true })).body.error).toBe("weak_password");
    expect((await pw(cookie, { currentPassword: PASSWORD, newPassword: PASSWORD, signOutOthers: true })).body.error).toBe("same_password");
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: user.id } })).passwordHash).toBe(user.passwordHash);
  });

  it("signOutOthers=true: 이 세션은 남고 다른 세션은 끝난다. 새 비밀번호로 로그인되고 옛 비밀번호는 안 된다", async () => {
    const { user } = await shopOwner();
    const here = await sellerLogin(user.email);
    const other = await sellerLogin(user.email);
    expect(await meStatus(other)).toBe(200);
    const r = await pw(here, { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: true });
    expect(r).toMatchObject({ status: 200, body: { ok: true, signedOutOthers: true, signedOutSessions: 1 } });
    expect(await meStatus(here)).toBe(200);
    expect(await meStatus(other)).toBe(401);
    expect((await loginSeller(db, { email: user.email, password: PASSWORD }, {})).ok).toBe(false);
    expect((await loginSeller(db, { email: user.email, password: NEW_PW }, {})).ok).toBe(true);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "auth.seller.password_change" } });
    expect(log.after).toEqual({ signOutOthers: true, signedOutSessions: 1 });
    expect(JSON.stringify(log)).not.toContain(NEW_PW);
    expect(await meStatus(await sellerLogin(user.email, NEW_PW))).toBe(200);
  });

  it("signOutOthers=false: 다른 세션도 그대로 산다", async () => {
    const { user } = await shopOwner();
    const here = await sellerLogin(user.email);
    const other = await sellerLogin(user.email);
    expect((await pw(here, { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: false })).body).toMatchObject({ ok: true, signedOutOthers: false, signedOutSessions: 0 });
    expect(await meStatus(here)).toBe(200);
    expect(await meStatus(other)).toBe(200);
    expect((await loginSeller(db, { email: user.email, password: NEW_PW }, {})).ok).toBe(true);
  });

  it("본인 것만 바뀐다(같은 쇼핑몰의 다른 직원·다른 쇼핑몰 계정은 그대로). 비로그인 401, 마스터 대리 조회는 403", async () => {
    const { seller, user } = await shopOwner();
    const staff = await createSellerUser(seller.id, { permissions: [] });
    const other = await shopOwner();
    const cookie = await sellerLogin(user.email);
    expect((await pw("", { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: true })).status).toBe(401);
    expect((await pw(cookie, { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: true })).status).toBe(200);
    for (const u of [staff, other.user]) {
      expect((await db.sellerUser.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBe(u.passwordHash);
    }
    // 마스터 대리 조회 쿠키로는 바꿀 수 없다
    const su = await createAdmin("SUPER_ADMIN");
    const adminLogin = await loginAdmin(db, { email: su.email, password: PASSWORD }, {});
    if (!adminLogin.ok) throw new Error(adminLogin.reason);
    const start = await startImp(req(`/api/admin/sellers/${seller.id}/impersonate`, `lo_admin=${adminLogin.token}`, "POST", { reason: "확인" }), { params: Promise.resolve({ sellerId: seller.id }) });
    const imp = `lo_imp=${/lo_imp=([^;]+)/.exec(start.headers.get("set-cookie") ?? "")?.[1]}`;
    expect((await pw(imp, { currentPassword: PASSWORD, newPassword: "another-pw-999", signOutOthers: true })).status).toBe(403);
  });
});

describe("동시 변경(확인한 뒤 다른 곳에서 먼저 바꾼 경우)", () => {
  it("파트너스: 확인과 저장 사이에 비밀번호가 바뀌면 덮어쓰지 않고 changed_elsewhere", async () => {
    const { seller, user } = await shopOwner();
    const sellerCtx = { sellerId: seller.id, actorType: "SELLER_USER" as const, actorId: user.id, isOwner: true, permissions: [], readOnly: false };
    // 서비스가 읽은 해시(user.passwordHash)와 저장 시점의 해시가 다르게, 읽은 뒤 바로 다른 곳에서 바꾼 것처럼 DB를 바꾼다
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return async (fn: unknown, ...rest: unknown[]) => {
            await target.sellerUser.update({ where: { id: user.id }, data: { passwordHash: await hashPassword("elsewhere-password-1") } });
            return (target.$transaction as (...a: unknown[]) => unknown)(fn, ...rest);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const r = await changeSellerPassword(racing, sellerCtx, "00000000-0000-4000-8000-000000000000", { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: true });
    expect(r).toEqual({ ok: false, reason: "changed_elsewhere" });
    const kept = await db.sellerUser.findUniqueOrThrow({ where: { id: user.id } });
    expect(kept.passwordHash).not.toBe(user.passwordHash);
    expect(await db.auditLog.count({ where: { action: "auth.seller.password_change" } })).toBe(0);
  });

  it("마스터 관리자: 같은 상황에서 덮어쓰지 않는다", async () => {
    const a = await createAdmin("OPERATIONS");
    const racing = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return async (fn: unknown, ...rest: unknown[]) => {
            await target.platformAdmin.update({ where: { id: a.id }, data: { passwordHash: await hashPassword("elsewhere-password-1") } });
            return (target.$transaction as (...a: unknown[]) => unknown)(fn, ...rest);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const r = await changeAdminPassword(racing, a.id, "00000000-0000-4000-8000-000000000000", { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: true });
    expect(r).toEqual({ ok: false, reason: "changed_elsewhere" });
    expect(await db.auditLog.count({ where: { action: "auth.admin.password_change" } })).toBe(0);
  });
});

describe("파트너스 내 이름 PATCH /api/seller/me/name", () => {
  it("정규화해 저장하고 로그 추적에 전후를 남긴다. 빈 이름·50자 초과·제어 문자는 400. 본인 것만 바뀐다", async () => {
    const { seller, user } = await shopOwner();
    const staff = await createSellerUser(seller.id, { permissions: [] });
    const cookie = await sellerLogin(user.email);
    const ok = await json(nameRoute(req("/api/seller/me/name", cookie, "PATCH", { name: "  홍길동  " })));
    expect(ok).toMatchObject({ status: 200, body: { ok: true, name: "홍길동" } });
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: user.id } })).name).toBe("홍길동");
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: staff.id } })).name).toBe(staff.name);
    const log = await db.auditLog.findFirstOrThrow({ where: { action: "auth.seller.name_change" } });
    expect(log).toMatchObject({ before: { name: user.name }, after: { name: "홍길동" } });
    for (const bad of ["", "   ", "가".repeat(51), "홍​길동", 5, null]) {
      expect(await json(nameRoute(req("/api/seller/me/name", cookie, "PATCH", { name: bad })))).toMatchObject({ status: 400, body: { error: "invalid_name" } });
    }
    expect((await json(nameRoute(req("/api/seller/me/name", "", "PATCH", { name: "홍길동" })))).status).toBe(401);
    // 같은 이름으로 다시 보내면 로그를 늘리지 않는다
    await nameRoute(req("/api/seller/me/name", cookie, "PATCH", { name: "홍길동" }));
    expect(await db.auditLog.count({ where: { action: "auth.seller.name_change" } })).toBe(1);
  });
});

describe("마스터 관리자 내 비밀번호 POST /api/admin/me/password", () => {
  const adminPw = (cookie: string, body: unknown) => json(adminPwRoute(req("/api/admin/me/password", cookie, "POST", body)));
  async function adminLogin(email: string, password = PASSWORD) {
    const r = await loginAdmin(db, { email, password }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_admin=${r.token}`;
  }

  it("모든 역할(최고관리자 포함)이 본인 비밀번호를 바꾼다. 현재 비밀번호 확인, 다른 세션 로그아웃 여부, 로그 추적", async () => {
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      const a = await createAdmin(role);
      const here = await adminLogin(a.email);
      const other = await adminLogin(a.email);
      expect(await adminPw(here, { currentPassword: "틀린-비밀번호-1", newPassword: NEW_PW, signOutOthers: true })).toMatchObject({ status: 400, body: { error: "wrong_password" } });
      const ok = await adminPw(here, { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: true });
      expect(ok).toMatchObject({ status: 200, body: { ok: true, signedOutOthers: true, signedOutSessions: 1 } });
      expect((await json(adminPwRoute(req("/api/admin/me/password", other, "POST", {})))).status).toBe(401);
      expect((await adminPw(here, { currentPassword: NEW_PW, newPassword: "second-password-1", signOutOthers: false })).status).toBe(200);
      expect((await loginAdmin(db, { email: a.email, password: PASSWORD }, {})).ok).toBe(false);
      expect((await loginAdmin(db, { email: a.email, password: "second-password-1" }, {})).ok).toBe(true);
    }
    const logs = await db.auditLog.findMany({ where: { action: "auth.admin.password_change" } });
    expect(logs).toHaveLength(8);
    expect(logs.every((l) => l.actorType === "PLATFORM_ADMIN" && l.actorId === l.targetId)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(NEW_PW);
    expect(await db.auditLog.count({ where: { action: "auth.admin.password_change_failed" } })).toBe(4);
  });

  it("입력 검사와 본인만(다른 관리자 비밀번호는 그대로), 비로그인·파트너스 로그인 401", async () => {
    const a = await createAdmin("SUPER_ADMIN");
    const b = await createAdmin("CS");
    const cookie = await adminLogin(a.email);
    expect((await adminPw(cookie, { currentPassword: PASSWORD, newPassword: NEW_PW })).body.error).toBe("bad_request");
    expect((await adminPw(cookie, { currentPassword: PASSWORD, newPassword: "short", signOutOthers: true })).body.error).toBe("weak_password");
    expect((await adminPw(cookie, { currentPassword: PASSWORD, newPassword: PASSWORD, signOutOthers: true })).body.error).toBe("same_password");
    expect((await adminPw(cookie, { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: true, adminId: b.id })).status).toBe(200);
    expect((await db.platformAdmin.findUniqueOrThrow({ where: { id: b.id } })).passwordHash).toBe(b.passwordHash);
    expect((await adminPw("", { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: true })).status).toBe(401);
    const { user } = await shopOwner();
    expect((await adminPw(await sellerLogin(user.email), { currentPassword: PASSWORD, newPassword: NEW_PW, signOutOthers: true })).status).toBe(401);
  });
});
