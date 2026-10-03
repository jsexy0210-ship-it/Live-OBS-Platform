import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as loginRoute } from "../../app/api/seller/auth/login/route";
import { POST as findAccounts } from "../../app/api/seller/find-id/accounts/route";
import { POST as findConfirm } from "../../app/api/seller/find-id/confirm/route";
import { POST as findReset } from "../../app/api/seller/find-id/reset/route";
import { POST as findStart } from "../../app/api/seller/find-id/start/route";
import { POST as linkConfirm } from "../../app/api/seller/me/identity/confirm/route";
import { POST as linkRoute } from "../../app/api/seller/me/identity/link/route";
import { GET as linkStatus } from "../../app/api/seller/me/identity/route";
import { POST as linkStart } from "../../app/api/seller/me/identity/start/route";
import { POST as resetComplete } from "../../app/api/seller/password-reset/complete/route";
import { POST as resetConfirm } from "../../app/api/seller/password-reset/confirm/route";
import { POST as resetStart } from "../../app/api/seller/password-reset/start/route";
import { POST as resetVerify } from "../../app/api/seller/password-reset/verify/route";
import { PATCH as staffPatch } from "../../app/api/seller/staff/[userId]/route";
import { GET as staffList, POST as staffCreate } from "../../app/api/seller/staff/route";
import { startAccountRecovery } from "../../lib/server/auth/accountRecovery";
import { loginSeller } from "../../lib/server/auth/login";
import { startSellerPasswordReset } from "../../lib/server/auth/passwordReset";
import { RECOVERY_DAILY_LIMIT_PER_IP, RECOVERY_DAILY_LIMIT_PER_PHONE } from "../../lib/server/auth/recoveryLimit";
import { prisma } from "../../lib/server/db";
import { hashCi } from "../../lib/server/identity/ciHash";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { identityProvider } from "../../lib/server/identity/registry";
import { IDV_INPUT, PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { "content-type": "application/json", host: "localhost:3000", origin: BASE };
const req = (path: string, method: string, body?: unknown, cookie?: string) =>
  new Request(BASE + path, { method, headers: { ...H, ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const post = (path: string, body: unknown, cookie?: string) => req(path, "POST", body, cookie);
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0];
const fake = () => identityProvider() as FakeIdentityProvider;
const ctxOf = (userId: string) => ({ params: Promise.resolve({ userId }) });
const NEW_PASSWORD = "new-password-123";

// 대표자 CI가 등록된 쇼핑몰과 대표자 계정
async function shop(repCi = "REP-CI") {
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { representativeCiHash: hashCi(repCi), representativeVerifiedAt: new Date() } });
  const owner = await createSellerUser(seller.id, "OWNER");
  return { seller, owner };
}
async function sessionOf(email: string, shopSlug?: string) {
  const r = await loginSeller(db, { email, password: PASSWORD, shopSlug }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
// 공급자 결과(이름·휴대폰·CI)를 정하고 인증번호를 확인한다
async function confirmWith(confirm: (r: Request) => Promise<Response>, path: string, verificationId: string, cookie: string, result: { ci: string; name?: string; phone?: string }) {
  const { requestId } = await db.identityVerification.findUniqueOrThrow({ where: { id: verificationId } });
  fake().complete(requestId, { ci: result.ci, name: result.name ?? "직원", phone: result.phone ?? "01055556666", birthDate: new Date("1990-01-01") });
  const r = await confirm(post(path, { verificationId, code: "000000" }, cookie));
  expect(r.status).toBe(200);
}
// 직원을 본인확인으로 연결한다(대표자가 휴대폰 등록 → 직원 로그인 → 시작 → 확인 → 연결)
async function linkedStaff(sellerId: string, ci: string, email?: string) {
  const staff = await createSellerUser(sellerId, "MANAGER", email);
  await db.sellerUser.update({ where: { id: staff.id }, data: { phone: "01055556666" } });
  const cookie = await sessionOf(staff.email, (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).slug);
  const s = await linkStart(post("/api/seller/me/identity/start", { ...IDV_INPUT, name: "직원", phone: "010-5555-6666" }, cookie));
  expect(s.status).toBe(200);
  const flow = cookieOf(s, "lo_lidv");
  const { verificationId } = await s.json();
  await confirmWith(linkConfirm, "/api/seller/me/identity/confirm", verificationId, flow, { ci });
  const l = await linkRoute(post("/api/seller/me/identity/link", { verificationId }, `${cookie}; ${flow}`));
  expect(l.status).toBe(200);
  return { staff, cookie };
}

describe("로그인 탭(accountType)", () => {
  it("비밀번호가 맞고 탭과 계정 종류가 다르면 세션 없이 409 wrong_account_type, 같으면 200. 비밀번호가 틀리면 탭과 상관없이 401. 값이 없으면 종류를 보지 않는다", async () => {
    const { seller, owner } = await shop();
    const staff = await createSellerUser(seller.id, "MANAGER");
    const login = (email: string, password: string, accountType?: unknown) => loginRoute(post("/api/seller/auth/login", { email, password, ...(accountType === undefined ? {} : { accountType }) }));
    const wrong = await login(staff.email, PASSWORD, "owner");
    expect(wrong.status).toBe(409);
    expect((await wrong.json()).error).toBe("wrong_account_type");
    expect(wrong.headers.getSetCookie().some((c) => c.startsWith("lo_seller="))).toBe(false);
    expect((await login(owner.email, PASSWORD, "staff")).status).toBe(409);
    expect((await login(staff.email, PASSWORD, "staff")).status).toBe(200);
    expect((await login(owner.email, PASSWORD, "owner")).status).toBe(200);
    for (const t of ["owner", "staff"]) {
      const r = await login(staff.email, "wrong-password", t);
      expect(r.status).toBe(401);
      expect((await r.json()).error).toBe("invalid_credentials");
    }
    expect((await login(staff.email, PASSWORD)).status).toBe(200);
    expect((await login(staff.email, PASSWORD, "admin")).status).toBe(400);
    expect(await db.auditLog.count({ where: { action: "auth.seller.login_blocked", reason: "wrong_account_type" } })).toBe(2);
  });

  it("같은 이메일·비밀번호로 한 쇼핑몰 대표자, 다른 쇼핑몰 직원이면 탭으로 고른 계정으로 로그인된다", async () => {
    const a = await shop("CI-A");
    const b = await shop("CI-B");
    await createSellerUser(b.seller.id, "MANAGER", a.owner.email);
    expect((await loginRoute(post("/api/seller/auth/login", { email: a.owner.email, password: PASSWORD }))).status).toBe(409); // shop_required
    const asOwner = await loginSeller(db, { email: a.owner.email, password: PASSWORD, accountType: "owner" }, {});
    const asStaff = await loginSeller(db, { email: a.owner.email, password: PASSWORD, accountType: "staff" }, {});
    expect(asOwner.ok && asStaff.ok).toBe(true);
  });
});

describe("직원 이름·휴대폰(대표자 직원 관리)", () => {
  it("만들 때 휴대폰을 받고, 나중에 채우거나 바꿀 수 있다. 번호를 바꾸면 연결이 풀리고 감사 로그에는 번호 끝 4자리만 남는다", async () => {
    const { seller, owner } = await shop();
    const cookie = await sessionOf(owner.email);
    expect((await staffCreate(post("/api/seller/staff", { email: "s1@example.com", name: "김직원", password: "staff-pass-1", permissions: [], phone: "123" }, cookie))).status).toBe(400);
    const made = await staffCreate(post("/api/seller/staff", { email: "s1@example.com", name: "김직원", password: "staff-pass-1", permissions: [], phone: "010-1234-5678" }, cookie));
    expect(made.status).toBe(201);
    const { id } = await made.json();
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id } })).phone).toBe("01012345678");
    // 기존 직원(번호 없음)에게 번호를 채운다
    const old = await createSellerUser(seller.id, "MANAGER");
    const filled = await staffPatch(req(`/api/seller/staff/${old.id}`, "PATCH", { phone: "01099998888", name: "박직원" }, cookie), ctxOf(old.id));
    expect(await filled.json()).toEqual({ name: "박직원", phone: "01099998888", identityLinked: false });
    // 연결된 직원의 번호를 바꾸면 연결이 풀린다
    await db.sellerUser.update({ where: { id }, data: { identityCiHash: hashCi("S1"), identityLinkedAt: new Date() } });
    expect((await (await staffList(req("/api/seller/staff", "GET", undefined, cookie))).json()).staff.find((x: { id: string }) => x.id === id)).toMatchObject({ phone: "01012345678", identityLinked: true });
    const same = await staffPatch(req(`/api/seller/staff/${id}`, "PATCH", { name: "김직원2" }, cookie), ctxOf(id));
    expect(await same.json()).toMatchObject({ identityLinked: true });
    const changed = await staffPatch(req(`/api/seller/staff/${id}`, "PATCH", { phone: "01011112222" }, cookie), ctxOf(id));
    expect(await changed.json()).toEqual({ name: "김직원2", phone: "01011112222", identityLinked: false });
    expect(await db.sellerUser.findUniqueOrThrow({ where: { id } })).toMatchObject({ identityCiHash: null, identityLinkedAt: null });
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "seller.staff.profile", targetId: id }, orderBy: { createdAt: "desc" } });
    expect(audit.after).toMatchObject({ phone: "***2222", identityUnlinked: true });
    expect(JSON.stringify(audit)).not.toContain("01011112222");
    expect((await staffPatch(req(`/api/seller/staff/${id}`, "PATCH", { phone: "abc" }, cookie), ctxOf(id))).status).toBe(400);
    // 직원은 직원 정보를 고칠 수 없다
    const staffLogin = await loginSeller(db, { email: "s1@example.com", password: "staff-pass-1" }, {});
    if (!staffLogin.ok) throw new Error(staffLogin.reason);
    const staffCookie = `lo_seller=${staffLogin.token}`;
    expect((await staffPatch(req(`/api/seller/staff/${old.id}`, "PATCH", { phone: "01000000000" }, staffCookie), ctxOf(old.id))).status).toBe(403);
  });
});

describe("직원 본인확인 연결", () => {
  it("등록한 이름·번호와 결과가 맞으면 연결된다. 입력이 다르면 문자 없이 409, 번호가 없으면 409, 결과 이름이 다르면 연결하지 않는다. 대표자는 대상이 아니다", async () => {
    const { seller, owner } = await shop();
    const staff = await createSellerUser(seller.id, "MANAGER");
    const cookie = await sessionOf(staff.email);
    const start = (body: unknown) => linkStart(post("/api/seller/me/identity/start", body, cookie));
    expect((await (await start({ ...IDV_INPUT, name: "직원" })).json()).error).toBe("phone_not_registered");
    await db.sellerUser.update({ where: { id: staff.id }, data: { phone: "01055556666" } });
    expect(await (await linkStatus(req("/api/seller/me/identity", "GET", undefined, cookie))).json()).toMatchObject({ phoneRegistered: true, linked: false });
    const sentBefore = fake().sent.length;
    const mismatch = await start({ ...IDV_INPUT, name: "남", phone: "01055556666" });
    expect(mismatch.status).toBe(409);
    expect((await mismatch.json()).error).toBe("identity_mismatch");
    expect((await start({ ...IDV_INPUT, name: "직원", phone: "01000001111" })).status).toBe(409);
    expect(fake().sent.length).toBe(sentBefore);
    // 결과 이름이 등록 이름과 다르면 연결하지 않는다(본인확인은 소진)
    const s = await start({ ...IDV_INPUT, name: "직원", phone: "01055556666" });
    const flow = cookieOf(s, "lo_lidv");
    const { verificationId } = await s.json();
    await confirmWith(linkConfirm, "/api/seller/me/identity/confirm", verificationId, flow, { ci: "OTHER", name: "다른사람" });
    const bad = await linkRoute(post("/api/seller/me/identity/link", { verificationId }, `${cookie}; ${flow}`));
    expect(bad.status).toBe(409);
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: staff.id } })).identityCiHash).toBeNull();
    expect((await linkRoute(post("/api/seller/me/identity/link", { verificationId }, `${cookie}; ${flow}`))).status).toBe(400);
    // 맞으면 연결
    await db.sellerUser.delete({ where: { id: staff.id } }).catch(() => undefined);
    const { staff: linked, cookie: linkedCookie } = await linkedStaff(seller.id, "STAFF-CI");
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: linked.id } })).identityCiHash).toBe(hashCi("STAFF-CI"));
    expect(await (await linkStatus(req("/api/seller/me/identity", "GET", undefined, linkedCookie))).json()).toMatchObject({ phoneRegistered: true, linked: true });
    expect(await db.auditLog.count({ where: { action: "seller.staff.identity_linked", targetId: linked.id } })).toBe(1);
    // 대표자는 403
    expect((await linkStatus(req("/api/seller/me/identity", "GET", undefined, await sessionOf(owner.email)))).status).toBe(403);
  });
});

describe("직원 연결 상태 GET /api/seller/me/identity", () => {
  it("본인확인 사용 가능 여부·등록 번호 끝 4자리·연결 여부를 주고, 번호 변경으로 풀리면 relinkRequired, 다시 연결하면 해제된다. 다른 직원·대표자에게는 새지 않는다", async () => {
    const { seller, owner } = await shop();
    const other = await shop("OTHER-REP");
    const status = async (cookie: string) => (await linkStatus(req("/api/seller/me/identity", "GET", undefined, cookie))).json();
    // 다른 쇼핑몰 직원(번호 01077778888)
    const otherStaff = await createSellerUser(other.seller.id, "MANAGER");
    await db.sellerUser.update({ where: { id: otherStaff.id }, data: { phone: "01077778888" } });
    // 처음 미연결: 다시 연결 필요 아님
    const fresh = await createSellerUser(seller.id, "MANAGER");
    await db.sellerUser.update({ where: { id: fresh.id }, data: { phone: "01055556666" } });
    expect(await status(await sessionOf(fresh.email))).toEqual({ available: true, phoneRegistered: true, registeredPhoneLast4: "6666", linked: false, relinkRequired: false });
    // 연결 → 대표자가 번호 변경 → 다시 연결 필요 → 다시 연결하면 해제
    const { staff, cookie } = await linkedStaff(seller.id, "STAFF-CI");
    expect(await status(cookie)).toMatchObject({ linked: true, relinkRequired: false, registeredPhoneLast4: "6666" });
    await staffPatch(req(`/api/seller/staff/${staff.id}`, "PATCH", { phone: "01055550000" }, await sessionOf(owner.email)), ctxOf(staff.id));
    const after = await status(cookie);
    expect(after).toEqual({ available: true, phoneRegistered: true, registeredPhoneLast4: "0000", linked: false, relinkRequired: true });
    expect(JSON.stringify(after)).not.toContain("01055550000");
    expect(JSON.stringify(after)).not.toContain("7777");
    await db.sellerUser.update({ where: { id: staff.id }, data: { phone: "01055556666" } });
    const s = await linkStart(post("/api/seller/me/identity/start", { ...IDV_INPUT, name: "직원", phone: "01055556666" }, cookie));
    const flow = cookieOf(s, "lo_lidv");
    const { verificationId } = await s.json();
    await confirmWith(linkConfirm, "/api/seller/me/identity/confirm", verificationId, flow, { ci: "STAFF-CI" });
    expect((await linkRoute(post("/api/seller/me/identity/link", { verificationId }, `${cookie}; ${flow}`))).status).toBe(200);
    expect(await status(cookie)).toMatchObject({ linked: true, relinkRequired: false });
    // 대표자는 403(다른 직원 값을 볼 수 없음)
    expect((await linkStatus(req("/api/seller/me/identity", "GET", undefined, await sessionOf(owner.email)))).status).toBe(403);
  });
});

describe("비밀번호 찾기(이메일+쇼핑몰) 직원", () => {
  const run = async (email: string, shopSlug: string, accountType: "owner" | "staff", ci: string) => {
    const s = await resetStart(post("/api/seller/password-reset/start", { email, shopSlug, person: { ...IDV_INPUT, name: "직원", phone: "01055556666" }, accountType }));
    expect(s.status).toBe(200);
    const flow = cookieOf(s, "lo_idv");
    const { verificationId } = await s.json();
    await confirmWith(resetConfirm, "/api/seller/password-reset/confirm", verificationId, flow, { ci });
    return resetVerify(post("/api/seller/password-reset/verify", { verificationId }, flow));
  };

  it("직원 본인확인 시작: 같은 직원·같은 attemptKey로 다시 보내면 같은 본인확인·같은 쿠키 값이고 문자·하루 횟수는 1회만 쓴다. 다른 직원은 같은 키여도 새로 시작, 확인 뒤 같은 키는 409", async () => {
    const { seller } = await shop();
    const staff = await createSellerUser(seller.id, "MANAGER");
    const other = await createSellerUser(seller.id, "MANAGER");
    for (const u of [staff, other]) await db.sellerUser.update({ where: { id: u.id }, data: { phone: "01055556666" } });
    const cookie = await sessionOf(staff.email);
    const key = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
    const body = { ...IDV_INPUT, name: "직원", phone: "01055556666", attemptKey: key };
    const sentBefore = fake().sent.length;
    const first = await linkStart(post("/api/seller/me/identity/start", body, cookie));
    expect(first.status).toBe(200);
    const again = await linkStart(post("/api/seller/me/identity/start", body, cookie));
    expect(again.status).toBe(200);
    const { verificationId } = await first.json();
    expect((await again.json()).verificationId).toBe(verificationId);
    expect(cookieOf(again, "lo_lidv")).toBe(cookieOf(first, "lo_lidv"));
    expect(fake().sent.length).toBe(sentBefore + 1);
    expect(await db.identityVerification.count({ where: { purpose: "STAFF_LINK", subjectId: staff.id } })).toBe(1);
    // 다른 직원이 같은 키를 쓰면 다른 기록
    const otherStart = await linkStart(post("/api/seller/me/identity/start", body, await sessionOf(other.email)));
    expect(otherStart.status).toBe(200);
    expect((await otherStart.json()).verificationId).not.toBe(verificationId);
    // 형식이 틀린 키는 400(문자 안 보냄)
    const sentNow = fake().sent.length;
    expect((await linkStart(post("/api/seller/me/identity/start", { ...body, attemptKey: "abc" }, cookie))).status).toBe(400);
    expect(fake().sent.length).toBe(sentNow);
    // 확인을 마친 뒤 같은 키는 409 already_verified
    await confirmWith(linkConfirm, "/api/seller/me/identity/confirm", verificationId, cookieOf(first, "lo_lidv"), { ci: "STAFF-CI" });
    const done = await linkStart(post("/api/seller/me/identity/start", body, cookie));
    expect(done.status).toBe(409);
    expect((await done.json()).error).toBe("already_verified");
  });

  it("연결 결과를 비교한 뒤 저장하기 전에 대표자가 직원 이름을 바꾸면 연결하지 않는다(직원 행을 잠그고 다시 비교)", async () => {
    const { seller } = await shop();
    const staff = await createSellerUser(seller.id, "MANAGER");
    await db.sellerUser.update({ where: { id: staff.id }, data: { phone: "01055556666" } });
    const cookie = await sessionOf(staff.email);
    const s = await linkStart(post("/api/seller/me/identity/start", { ...IDV_INPUT, name: "직원", phone: "01055556666" }, cookie));
    const flow = cookieOf(s, "lo_lidv");
    const { verificationId } = await s.json();
    await confirmWith(linkConfirm, "/api/seller/me/identity/confirm", verificationId, flow, { ci: "STAFF-CI" });
    // 연결 트랜잭션이 시작되기 직전에 대표자가 이름을 바꾼다
    const { linkStaffIdentity } = await import("../../lib/server/sellers/staffIdentity");
    const { requireSeller } = await import("../../lib/server/authz/guards");
    const ctx = await requireSeller(db, cookie.replace("lo_seller=", ""));
    const racing = new Proxy(db, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p !== "$transaction") return typeof v === "function" ? v.bind(t) : v;
        return async (...args: unknown[]) => {
          await db.sellerUser.update({ where: { id: staff.id }, data: { name: "다른이름" } });
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    }) as typeof db;
    const r = await linkStaffIdentity(racing, fake(), ctx, { verificationId, ownerToken: flow.split("=")[1] });
    expect(r).toEqual({ ok: false, reason: "identity_mismatch" });
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: staff.id } })).identityCiHash).toBeNull();
  });

  it("직원 이름 상한은 만들기·고치기·연결에 같은 50자: 40자 이름 직원도 연결을 시작하고, 51자는 만들 때·고칠 때 400", async () => {
    const { seller, owner } = await shop();
    const ownerCookie = await sessionOf(owner.email);
    const long = "가".repeat(40);
    const created = await staffCreate(post("/api/seller/staff", { email: "long@example.com", name: long, password: PASSWORD, permissions: [], phone: "01055556666" }, ownerCookie));
    expect(created.status).toBe(201);
    const tooLong = await staffCreate(post("/api/seller/staff", { email: "too@example.com", name: "가".repeat(51), password: PASSWORD, permissions: [] }, ownerCookie));
    expect(tooLong.status).toBe(400);
    const { id } = await created.json();
    expect((await staffPatch(req(`/api/seller/staff/${id}`, "PATCH", { name: "가".repeat(51) }, ownerCookie), ctxOf(id))).status).toBe(400);
    const staffCookie = await sessionOf("long@example.com", seller.slug);
    const s = await linkStart(post("/api/seller/me/identity/start", { ...IDV_INPUT, name: long, phone: "01055556666" }, staffCookie));
    expect(s.status).toBe(200);
  });

  it("연결 CI가 맞는 직원은 재설정 권한을 받아 새 비밀번호로 로그인된다. CI가 다르거나·연결 전이거나·탭이 다르면 같은 거부", async () => {
    const { seller } = await shop();
    const { staff } = await linkedStaff(seller.id, "STAFF-CI");
    const unlinked = await createSellerUser(seller.id, "MANAGER");
    for (const [email, type, ci] of [
      [staff.email, "staff", "OTHER-CI"],
      [unlinked.email, "staff", "STAFF-CI"],
      [staff.email, "owner", "STAFF-CI"],
    ] as const) {
      const r = await run(email, seller.slug, type, ci);
      expect(r.status, `${email} ${type} ${ci}`).toBe(400);
      expect(await r.json()).toEqual({ error: "reset_not_allowed" });
    }
    const ok = await run(staff.email, seller.slug, "staff", "STAFF-CI");
    expect(ok.status).toBe(200);
    const grant = cookieOf(ok, "lo_pwreset");
    expect((await resetComplete(post("/api/seller/password-reset/complete", { newPassword: NEW_PASSWORD }, grant))).status).toBe(200);
    expect((await loginSeller(db, { email: staff.email, password: NEW_PASSWORD, accountType: "staff" }, {})).ok).toBe(true);
  });

  it("권한을 받은 뒤 대표자가 번호를 바꿔 연결이 풀리면 그 권한으로 바꿀 수 없다", async () => {
    const { seller, owner } = await shop();
    const { staff } = await linkedStaff(seller.id, "STAFF-CI");
    const ok = await run(staff.email, seller.slug, "staff", "STAFF-CI");
    const grant = cookieOf(ok, "lo_pwreset");
    await staffPatch(req(`/api/seller/staff/${staff.id}`, "PATCH", { phone: "01077778888" }, await sessionOf(owner.email)), ctxOf(staff.id));
    expect((await resetComplete(post("/api/seller/password-reset/complete", { newPassword: NEW_PASSWORD }, grant))).status).toBe(400);
  });
});

describe("아이디 찾기·계정 고르기 비밀번호 찾기", () => {
  const begin = async () => {
    const s = await findStart(post("/api/seller/find-id/start", { ...IDV_INPUT, name: "직원", phone: "01055556666" }));
    expect(s.status).toBe(200);
    return { flow: cookieOf(s, "lo_fidv"), verificationId: (await s.json()).verificationId as string };
  };

  it("대표자 탭: 대표자 CI가 같은 쇼핑몰의 대표자 계정을 쇼핑몰 이름·이메일과 함께 보여 주고(해지된 쇼핑몰 제외), 고른 계정만 재설정한다. 본인확인은 한 번만 쓴다", async () => {
    // 대표자 1명당 운영 중 쇼핑몰은 1개(부분 유니크). 해지한 예전 쇼핑몰은 목록에 나오지 않는다.
    const closed = await shop("ME");
    await db.seller.update({ where: { id: closed.seller.id }, data: { status: "CLOSED" } });
    const b = await shop("ME");
    const a = await shop("SOMEONE-ELSE");
    const c = await shop("SOMEONE");
    const { flow, verificationId } = await begin();
    // 확인 전이면 409
    expect((await findAccounts(post("/api/seller/find-id/accounts", { verificationId, accountType: "owner" }, flow))).status).toBe(409);
    await confirmWith(findConfirm, "/api/seller/find-id/confirm", verificationId, flow, { ci: "ME" });
    // 쿠키 없으면 거부
    expect((await findAccounts(post("/api/seller/find-id/accounts", { verificationId, accountType: "owner" }))).status).toBe(400);
    const list = await (await findAccounts(post("/api/seller/find-id/accounts", { verificationId, accountType: "owner" }, flow))).json();
    expect(list.accounts.map((x: { email: string }) => x.email)).toEqual([b.owner.email]);
    expect(list.accounts[0]).toEqual({ accountId: expect.any(String), shopName: expect.any(String), shopSlug: expect.any(String), email: expect.any(String) });
    expect((await (await findAccounts(post("/api/seller/find-id/accounts", { verificationId, accountType: "staff" }, flow))).json()).accounts).toEqual([]);
    // 목록에 없는 계정(다른 사람)은 거부, 본인확인은 그대로
    expect((await findReset(post("/api/seller/find-id/reset", { verificationId, accountType: "owner", accountId: c.owner.id }, flow))).status).toBe(400);
    const r = await findReset(post("/api/seller/find-id/reset", { verificationId, accountType: "owner", accountId: b.owner.id }, flow));
    expect(r.status).toBe(200);
    const grant = cookieOf(r, "lo_pwreset");
    expect((await resetComplete(post("/api/seller/password-reset/complete", { newPassword: NEW_PASSWORD }, grant))).status).toBe(200);
    expect((await loginSeller(db, { email: b.owner.email, password: NEW_PASSWORD, shopSlug: b.seller.slug }, {})).ok).toBe(true);
    // 같은 본인확인으로 다시 쓸 수 없다
    expect((await findReset(post("/api/seller/find-id/reset", { verificationId, accountType: "owner", accountId: b.owner.id }, flow))).status).toBe(400);
    expect(a.owner.id).not.toBe(b.owner.id);
  });

  it("재설정 권한 응답을 잃으면 같은 본인확인·같은 계정으로 10분 안에 다시 요청해 같은 권한을 받는다(동시 재시도도 같은 토큰). 다른 흐름의 권한은 그대로이고, 다른 계정·쓴 뒤·10분 뒤는 거부", async () => {
    const me = await shop("ME");
    const other = await shop("OTHER");
    // 같은 계정의 다른 아이디 찾기 흐름이 먼저 받은 권한
    const b = await begin();
    await confirmWith(findConfirm, "/api/seller/find-id/confirm", b.verificationId, b.flow, { ci: "ME" });
    const otherFlow = cookieOf(await findReset(post("/api/seller/find-id/reset", { verificationId: b.verificationId, accountType: "owner", accountId: me.owner.id }, b.flow)), "lo_pwreset");

    const { flow, verificationId } = await begin();
    await confirmWith(findConfirm, "/api/seller/find-id/confirm", verificationId, flow, { ci: "ME" });
    const reset = (accountId: string, cookie = flow) => findReset(post("/api/seller/find-id/reset", { verificationId, accountType: "owner", accountId }, cookie));
    const first = await reset(me.owner.id);
    expect(first.status).toBe(200);
    // 성공 응답이 흐름 쿠키를 지우지 않는다(잃은 응답을 다시 받으려면 필요)
    expect(first.headers.getSetCookie().filter((c) => c.startsWith("lo_fidv="))).toEqual([]);
    const token = cookieOf(first, "lo_pwreset");
    // 응답을 잃었다고 보고 다시 요청(동시 2건): 모두 같은 토큰, 권한 행은 하나
    const retries = await Promise.all([reset(me.owner.id), reset(me.owner.id)]);
    expect(retries.map((r) => r.status)).toEqual([200, 200]);
    expect(retries.map((r) => cookieOf(r, "lo_pwreset"))).toEqual([token, token]);
    expect(await db.passwordResetGrant.count({ where: { verificationId } })).toBe(1);
    // 다른 계정·쿠키 없는 재시도는 거부
    expect((await reset(other.owner.id)).status).toBe(400);
    expect((await reset(me.owner.id, "")).status).toBe(400);
    // 다른 흐름의 권한은 재시도에 영향받지 않는다(그 권한으로 바꿀 수 있다)
    expect((await resetComplete(post("/api/seller/password-reset/complete", { newPassword: "other-flow-pass-1" }, otherFlow))).status).toBe(200);
    expect((await loginSeller(db, { email: me.owner.email, password: "other-flow-pass-1", shopSlug: me.seller.slug }, {})).ok).toBe(true);

    // 새 흐름: 같은 토큰으로 한 번 바꾸면 다시 받을 수도, 다시 쓸 수도 없다
    const c = await begin();
    await confirmWith(findConfirm, "/api/seller/find-id/confirm", c.verificationId, c.flow, { ci: "OTHER" });
    const resetC = () => findReset(post("/api/seller/find-id/reset", { verificationId: c.verificationId, accountType: "owner", accountId: other.owner.id }, c.flow));
    const [c1, c2] = await Promise.all([resetC(), resetC()]);
    const tokenC = cookieOf(c1, "lo_pwreset");
    expect(cookieOf(c2, "lo_pwreset")).toBe(tokenC);
    expect((await resetComplete(post("/api/seller/password-reset/complete", { newPassword: NEW_PASSWORD }, tokenC))).status).toBe(200);
    expect((await resetComplete(post("/api/seller/password-reset/complete", { newPassword: "again-pass-123" }, cookieOf(c2, "lo_pwreset")))).status).toBe(400);
    expect((await resetC()).status).toBe(400);

    // 본인확인 유효 시간이 지났어도 소진 뒤 10분 안이면 같은 권한을 다시 받고, 10분이 지나면 거부
    const d = await begin();
    await confirmWith(findConfirm, "/api/seller/find-id/confirm", d.verificationId, d.flow, { ci: "OTHER" });
    const resetD = () => findReset(post("/api/seller/find-id/reset", { verificationId: d.verificationId, accountType: "owner", accountId: other.owner.id }, d.flow));
    const tokenD = cookieOf(await resetD(), "lo_pwreset");
    await db.identityVerification.update({ where: { id: d.verificationId }, data: { expiresAt: new Date(Date.now() - 60_000), consumedAt: new Date(Date.now() - 5 * 60_000) } });
    const late = await resetD();
    expect(late.status).toBe(200);
    expect(cookieOf(late, "lo_pwreset")).toBe(tokenD);
    await db.identityVerification.update({ where: { id: d.verificationId }, data: { consumedAt: new Date(Date.now() - 11 * 60_000) } });
    expect((await resetD()).status).toBe(400);
  });

  it("직원 탭: 여러 쇼핑몰에 연결된 직원 계정을 쇼핑몰 이름과 함께 모두 보여 준다", async () => {
    const a = await shop("A");
    const b = await shop("B");
    await linkedStaff(a.seller.id, "STAFF-CI", "same@example.com");
    await linkedStaff(b.seller.id, "STAFF-CI", "same@example.com");
    const { flow, verificationId } = await begin();
    await confirmWith(findConfirm, "/api/seller/find-id/confirm", verificationId, flow, { ci: "STAFF-CI" });
    const list = await (await findAccounts(post("/api/seller/find-id/accounts", { verificationId, accountType: "staff" }, flow))).json();
    expect(list.accounts.map((x: { shopSlug: string }) => x.shopSlug).sort()).toEqual([a.seller.slug, b.seller.slug].sort());
  });

  it("직원 탭: 같은 쇼핑몰의 복수 계정을 모두 보여 주고, 연결되지 않았거나 다른 CI인 직원·비활성 계정은 보이지 않는다", async () => {
    const { seller } = await shop();
    const one = await linkedStaff(seller.id, "STAFF-CI", "one@example.com");
    const two = await linkedStaff(seller.id, "STAFF-CI", "two@example.com");
    const other = await linkedStaff(seller.id, "OTHER-CI", "other@example.com");
    await createSellerUser(seller.id, "MANAGER", "unlinked@example.com");
    const off = await linkedStaff(seller.id, "STAFF-CI", "off@example.com");
    await db.sellerUser.update({ where: { id: off.staff.id }, data: { status: "DISABLED" } });
    const { flow, verificationId } = await begin();
    await confirmWith(findConfirm, "/api/seller/find-id/confirm", verificationId, flow, { ci: "STAFF-CI" });
    const list = await (await findAccounts(post("/api/seller/find-id/accounts", { verificationId, accountType: "staff" }, flow))).json();
    expect(list.accounts.map((x: { email: string }) => x.email)).toEqual(["one@example.com", "two@example.com"]);
    expect(list.accounts.some((x: { accountId: string }) => x.accountId === other.staff.id)).toBe(false);
    expect(one.staff.id && two.staff.id).toBeTruthy();
  });
});

describe("아이디·비밀번호 찾기 한도(같은 휴대폰 하루 10회·같은 IP 하루 30회 합산)", () => {
  it("하루 횟수 기간이 지난 아이디 찾기·직원 연결 본인확인 기록은 정기 실행이 개인정보를 비우고, 오늘 기록·하루 횟수·직원 연결 CI는 그대로다", async () => {
    const { seller } = await shop();
    const { staff } = await linkedStaff(seller.id, "STAFF-CI");
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 86_400_000);
    const row = (purpose: "ACCOUNT_RECOVERY" | "STAFF_LINK", createdAt: Date, phone: string) =>
      db.identityVerification.create({
        data: {
          purpose,
          sellerId: purpose === "STAFF_LINK" ? seller.id : null,
          subjectId: purpose === "STAFF_LINK" ? staff.id : null,
          provider: "fake",
          method: "SMS",
          requestId: `req-${Math.random()}`,
          requestedPhone: phone,
          name: "직원",
          phone,
          birthDate: new Date("1990-01-01"),
          ciHash: "ci",
          ownerTokenHash: "h",
          requestIp: "203.0.113.9",
          status: "VERIFIED",
          verifiedAt: createdAt,
          createdAt,
          expiresAt: new Date(createdAt.getTime() + 20 * 60_000),
        },
      });
    const oldRecovery = await row("ACCOUNT_RECOVERY", old, "01011112222");
    const oldLink = await row("STAFF_LINK", old, "01055556666");
    // 오늘 같은 번호로 하루 한도만큼 시작한 기록
    for (let i = 0; i < RECOVERY_DAILY_LIMIT_PER_PHONE; i++) await row("ACCOUNT_RECOVERY", now, "01099998888");
    const { purgeOldRecoveryVerifications } = await import("../../lib/server/auth/accountRecovery");
    const { SCHEDULED_JOBS } = await import("../../lib/server/jobs/scheduler");
    expect(SCHEDULED_JOBS.map((j) => j.name)).toContain("identity_verification.anonymize_old_recovery");
    expect(await purgeOldRecoveryVerifications(db, now)).toBeGreaterThanOrEqual(2);
    for (const id of [oldRecovery.id, oldLink.id]) {
      const v = await db.identityVerification.findUniqueOrThrow({ where: { id } });
      expect(v).toMatchObject({ name: null, phone: null, requestedPhone: null, birthDate: null, ciHash: null, subjectId: null, ownerTokenHash: null, requestIp: null, status: "VERIFIED" });
      expect(v.anonymizedAt).not.toBeNull();
      expect(v.requestId).toMatch(/^anonymized:/);
    }
    // 오늘 기록은 그대로라 하루 한도도 그대로 걸린다
    expect(await db.identityVerification.count({ where: { requestedPhone: "01099998888", anonymizedAt: null } })).toBe(RECOVERY_DAILY_LIMIT_PER_PHONE);
    const limited = await findStart(post("/api/seller/find-id/start", { ...IDV_INPUT, name: "직원", phone: "01099998888" }));
    expect(limited.status).toBe(429);
    // 연결된 직원의 CI는 계정 쪽에 그대로
    expect((await db.sellerUser.findUniqueOrThrow({ where: { id: staff.id } })).identityCiHash).toBe(hashCi("STAFF-CI"));
  });

  it("같은 휴대폰은 아이디 찾기·비밀번호 찾기를 합쳐 하루 10회까지, 11번째는 거부되고 문자를 보내지 않는다", async () => {
    const { seller, owner } = await shop();
    const provider = fake();
    const person = { ...IDV_INPUT, phone: "01012340000" };
    for (let i = 0; i < RECOVERY_DAILY_LIMIT_PER_PHONE; i++) {
      const r =
        i % 2 === 0
          ? await startAccountRecovery(db, provider, person, { ip: `10.0.0.${i}` })
          : await startSellerPasswordReset(db, provider, { email: owner.email, shopSlug: seller.slug, person }, { ip: `10.0.0.${i}` });
      expect(r.ok, String(i)).toBe(true);
    }
    const sent = provider.sent.length;
    expect(await startAccountRecovery(db, provider, person, { ip: "10.0.1.1" })).toEqual({ ok: false, reason: "recovery_limit_exceeded" });
    expect(await startSellerPasswordReset(db, provider, { email: owner.email, shopSlug: seller.slug, person }, { ip: "10.0.1.1" })).toEqual({ ok: false, reason: "reset_limit_exceeded" });
    expect(provider.sent.length).toBe(sent);
    // 다른 번호는 된다
    expect((await startAccountRecovery(db, provider, { ...person, phone: "01012340001" }, { ip: "10.0.1.1" })).ok).toBe(true);
    // HTTP는 429와 안내 문구
    const res = await findStart(post("/api/seller/find-id/start", person));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "recovery_limit_exceeded", message: "오늘은 더 인증할 수 없어요. 내일 다시 시도해 주세요" });
  });

  it("같은 IP는 번호가 달라도 하루 30회까지", async () => {
    const provider = fake();
    for (let i = 0; i < RECOVERY_DAILY_LIMIT_PER_IP; i++) {
      expect((await startAccountRecovery(db, provider, { ...IDV_INPUT, phone: `010200${String(i).padStart(5, "0")}` }, { ip: "10.9.9.9" })).ok).toBe(true);
    }
    expect(await startAccountRecovery(db, provider, { ...IDV_INPUT, phone: "01099990000" }, { ip: "10.9.9.9" })).toEqual({ ok: false, reason: "recovery_limit_exceeded" });
    expect((await startAccountRecovery(db, provider, { ...IDV_INPUT, phone: "01099990000" }, { ip: "10.9.9.8" })).ok).toBe(true);
  });
});
