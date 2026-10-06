import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as loginRoute } from "../../app/api/shop/[slug]/auth/login/route";
import { PUT as nicknamePut } from "../../app/api/shop/[slug]/me/nickname/route";
import { POST as passwordPost } from "../../app/api/shop/[slug]/me/password/route";
import { GET as profileGet } from "../../app/api/shop/[slug]/me/profile/route";
import { resetPasswordChangeLimiter, PASSWORD_CHANGE_FAIL_LIMIT } from "../../lib/server/buyers/profile";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

// SH-024 회원정보 수정 서버: 내 정보 조회(휴대폰 마스킹)·방송 닉네임 변경(30일에 1번)·비밀번호 변경(현재 비밀번호 확인, 다른 세션 무효화).
beforeEach(async () => {
  resetPasswordChangeLimiter();
  await resetDb();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { "content-type": "application/json", host: "localhost:3000", origin: BASE };
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const DAY = 24 * 60 * 60_000;

async function login(slug: string, loginId: string, password = PASSWORD) {
  const r = await loginRoute(new Request(`${BASE}/api/shop/${slug}/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ loginId, password }) }), ctx(slug));
  return { status: r.status, cookie: (r.headers.getSetCookie().find((c) => c.startsWith("lo_buyer=")) ?? "").split(";")[0] };
}

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  await db.buyerMember.update({ where: { id: buyer.id }, data: { phone: "01012345678", name: "김별빛" } });
  const { cookie } = await login(seller.slug, buyer.loginId);
  const req = (path: string, method: string, body: unknown, c: string | undefined = cookie) =>
    new Request(`${BASE}/api/shop/${seller.slug}/me/${path}`, { method, headers: { ...H, ...(c ? { cookie: c } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return {
    seller,
    grade,
    buyer,
    cookie,
    get: (c: string | undefined = cookie) => profileGet(req("profile", "GET", undefined, c), ctx(seller.slug)),
    nick: (body: unknown, c: string | undefined = cookie) => nicknamePut(req("nickname", "PUT", body, c), ctx(seller.slug)),
    pw: (body: unknown, c: string | undefined = cookie) => passwordPost(req("password", "POST", body, c), ctx(seller.slug)),
  };
}

describe("내 정보 조회", () => {
  it("아이디·이름·마스킹한 휴대폰·닉네임을 주고, 한 번도 안 바꿨으면 바로 바꿀 수 있다. 로그인 없음 401", async () => {
    const s = await shop();
    const r = await s.get();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ loginId: s.buyer.loginId, name: "김별빛", phoneMasked: "010-****-5678", broadcastNickname: s.buyer.broadcastNickname, nextNicknameChangeAt: null });
    expect((await s.get("")).status).toBe(401);
    await db.buyerMember.update({ where: { id: s.buyer.id }, data: { phone: "0111234567" } });
    expect((await (await s.get()).json()).phoneMasked).toBe("011-***-4567");
  });
});

describe("방송 닉네임 변경", () => {
  it("바꾸면 다음 변경일(30일 뒤)이 나오고, 30일 안에는 409, 지난 뒤에는 다시 바꿀 수 있다. 감사 로그 기록", async () => {
    const s = await shop();
    const r = await s.nick({ broadcastNickname: "  새닉네임 " });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.broadcastNickname).toBe("새닉네임");
    const next = new Date(body.nextNicknameChangeAt).getTime();
    expect(next - Date.now()).toBeGreaterThan(29 * DAY);
    expect(next - Date.now()).toBeLessThanOrEqual(30 * DAY);
    expect((await (await s.get()).json()).nextNicknameChangeAt).toBe(body.nextNicknameChangeAt);

    const limited = await s.nick({ broadcastNickname: "또바꿈" });
    expect(limited.status).toBe(409);
    expect(await limited.json()).toMatchObject({ error: "nickname_change_limited", nextNicknameChangeAt: body.nextNicknameChangeAt });
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).broadcastNickname).toBe("새닉네임");

    await db.buyerMember.update({ where: { id: s.buyer.id }, data: { broadcastNicknameChangedAt: new Date(Date.now() - 31 * DAY) } });
    expect((await s.nick({ broadcastNickname: "또바꿈" })).status).toBe(200);
    expect(await db.auditLog.count({ where: { action: "buyer.profile.nickname_change", actorId: s.buyer.id } })).toBe(2);
  });

  it("지금과 같은 닉네임은 바꾸지 않고 30일 제한도 쓰지 않는다", async () => {
    const s = await shop();
    const r = await s.nick({ broadcastNickname: s.buyer.broadcastNickname });
    expect(r.status).toBe(200);
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).broadcastNicknameChangedAt).toBeNull();
    expect(await db.auditLog.count({ where: { action: "buyer.profile.nickname_change" } })).toBe(0);
  });

  it("같은 쇼핑몰의 다른 회원과 겹치면 409(제한도 안 씀), 다른 쇼핑몰과는 겹쳐도 된다, 틀린 값은 400", async () => {
    const s = await shop();
    const other = await createLoginBuyer(s.seller.id, s.grade.id);
    const taken = await s.nick({ broadcastNickname: other.broadcastNickname });
    expect(taken.status).toBe(409);
    expect((await taken.json()).error).toBe("nickname_taken");
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).broadcastNicknameChangedAt).toBeNull();
    for (const bad of [undefined, "", "   ", "가".repeat(21), 123]) {
      const r = await s.nick({ broadcastNickname: bad });
      expect(r.status, String(bad)).toBe(400);
      expect((await r.json()).error).toBe("invalid_nickname");
    }
    expect((await s.nick({ broadcastNickname: "가".repeat(20) })).status).toBe(200);
    const s2 = await shop();
    expect((await s2.nick({ broadcastNickname: "가".repeat(20) })).status).toBe(200);
  });

  it("로그인 없음 401, 다른 출처 403", async () => {
    const s = await shop();
    expect((await s.nick({ broadcastNickname: "새로" }, "")).status).toBe(401);
    const noOrigin = await nicknamePut(new Request(`${BASE}/api/shop/${s.seller.slug}/me/nickname`, { method: "PUT", headers: { "content-type": "application/json", host: "localhost:3000", cookie: s.cookie }, body: JSON.stringify({ broadcastNickname: "새로" }) }), ctx(s.seller.slug));
    expect(noOrigin.status).toBe(403);
  });
});

describe("비밀번호 변경", () => {
  it("현재 비밀번호가 맞으면 바꾸고, 지금 세션만 남기고 다른 세션은 끝나며, 새 비밀번호로만 로그인된다", async () => {
    const s = await shop();
    const other = await login(s.seller.slug, s.buyer.loginId);
    expect((await s.get(other.cookie)).status).toBe(200);
    const r = await s.pw({ currentPassword: PASSWORD, newPassword: "new-password-9" });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, revokedSessions: 1 });
    expect((await s.get()).status).toBe(200);
    expect((await s.get(other.cookie)).status).toBe(401);
    expect((await login(s.seller.slug, s.buyer.loginId, PASSWORD)).status).not.toBe(200);
    expect((await login(s.seller.slug, s.buyer.loginId, "new-password-9")).status).toBe(200);
    expect(await db.auditLog.count({ where: { action: "buyer.profile.password_change", actorId: s.buyer.id } })).toBe(1);
  });

  it("바꾸면 아직 안 쓴 비밀번호 재설정 링크도 지운다", async () => {
    const s = await shop();
    await db.buyerPasswordReset.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, tokenHash: "h-1", expiresAt: new Date(Date.now() + 60_000) } });
    expect((await s.pw({ currentPassword: PASSWORD, newPassword: "new-password-9" })).status).toBe(200);
    expect(await db.buyerPasswordReset.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
  });

  it("현재 비밀번호가 틀리면 403(바뀌지 않음·401 아님), 새 비밀번호가 약하거나 같으면 400", async () => {
    const s = await shop();
    const wrong = await s.pw({ currentPassword: "nope-nope-1", newPassword: "new-password-9" });
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error).toBe("wrong_password");
    expect((await login(s.seller.slug, s.buyer.loginId, PASSWORD)).status).toBe(200);
    const weak = await s.pw({ currentPassword: PASSWORD, newPassword: "short" });
    expect(weak.status).toBe(400);
    expect((await weak.json()).error).toBe("weak_password");
    for (const w of ["onlyletters", "1234567890"]) expect((await s.pw({ currentPassword: PASSWORD, newPassword: w })).status, w).toBe(400);
    // 이미 쓰는 비밀번호는 기준과 상관없이 현재 비밀번호로 확인된다(기준은 새로 만들 때만)
    const same = await s.pw({ currentPassword: PASSWORD, newPassword: PASSWORD });
    expect(same.status).toBe(400);
    expect((await same.json()).error).toBe("same_password");
    expect((await s.pw({ currentPassword: PASSWORD })).status).toBe(400);
    expect((await s.pw({ newPassword: "new-password-9" })).status).toBe(403);
  });

  it(`현재 비밀번호를 ${PASSWORD_CHANGE_FAIL_LIMIT}번 틀리면 잠시 막고(맞는 비밀번호도 429), 다른 회원은 영향 없다`, async () => {
    const s = await shop();
    for (let i = 0; i < PASSWORD_CHANGE_FAIL_LIMIT; i++) expect((await s.pw({ currentPassword: "nope-nope-1", newPassword: "new-password-9" })).status).toBe(403);
    const blocked = await s.pw({ currentPassword: PASSWORD, newPassword: "new-password-9" });
    expect(blocked.status).toBe(429);
    expect((await blocked.json()).error).toBe("too_many_attempts");
    expect((await login(s.seller.slug, s.buyer.loginId, PASSWORD)).status).toBe(200);
    const s2 = await shop();
    expect((await s2.pw({ currentPassword: PASSWORD, newPassword: "new-password-9" })).status).toBe(200);
  });

  it("로그인 없음 401, 탈퇴한 회원의 세션은 쓸 수 없다", async () => {
    const s = await shop();
    expect((await s.pw({ currentPassword: PASSWORD, newPassword: "new-password-9" }, "")).status).toBe(401);
    await db.buyerMember.update({ where: { id: s.buyer.id }, data: { status: "WITHDRAWN", deletedAt: new Date() } });
    expect((await s.pw({ currentPassword: PASSWORD, newPassword: "new-password-9" })).status).toBe(401);
  });
});
