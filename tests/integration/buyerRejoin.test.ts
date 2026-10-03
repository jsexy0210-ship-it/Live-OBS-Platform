import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as policyGet, PUT as policyPut } from "../../app/api/seller/member-policy/route";
import { POST as signupRoute } from "../../app/api/shop/[slug]/signup/route";
import { POST as confirmRoute } from "../../app/api/shop/[slug]/signup/verification/confirm/route";
import { POST as startRoute } from "../../app/api/shop/[slug]/signup/verification/route";
import { loginSeller } from "../../lib/server/auth/login";
import { BUYER_SIGNUP_STATUS } from "../../lib/server/buyers/signup";
import { REJOIN_RESTRICTION_CONFIG, REJOIN_RETENTION_CONSENT_VERSION, purgeExpiredRejoinBlocks } from "../../lib/server/buyers/rejoin";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { IDV_INPUT, PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeAll(() => {
  // 동의 철회 기능 전에는 켤 수 없게 막아 두었다(rejoin.ts). 켜진 쇼핑몰 동작을 확인하려고 이 파일에서만 켠다.
  REJOIN_RESTRICTION_CONFIG.available = true;
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const post = (url: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost:3000${url}`, { method: "POST", headers: { ...H, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0];
const DAY = 24 * 3600_000;

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
  if (!login.ok) throw new Error(login.reason);
  const sellerCookie = `lo_seller=${login.token}`;
  const base = `/api/shop/${seller.slug}/signup`;
  // 본인확인부터 가입까지. 응답을 그대로 돌려준다.
  const shownDays = async () => (await db.sellerMemberPolicy.findUnique({ where: { sellerId: seller.id } }))?.rejoinRestrictionDays ?? 30;
  const verified = async (person: Partial<Record<keyof typeof IDV_INPUT, string>> = {}) => {
    const s = await startRoute(post(`${base}/verification`, { ...IDV_INPUT, ...person }), ctx(seller.slug));
    expect(s.status).toBe(200);
    const cookie = cookieOf(s, "lo_bidv");
    const { verificationId } = (await s.json()) as { verificationId: string };
    expect((await confirmRoute(post(`${base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(seller.slug))).status).toBe(200);
    return { verificationId, cookie };
  };
  // 화면처럼 보관에 동의하고 지금 정책 기간·문서 버전을 「보여 준 값」으로 함께 보낸다(extra로 덮어쓸 수 있다)
  const signupWith = async (v: { verificationId: string; cookie: string }, loginId = "buyer01@example.com", nickname = "카드왕", extra: Record<string, unknown> = {}) =>
    signupRoute(
      post(
        base,
        {
          verificationId: v.verificationId,
          loginId,
          password: "pw-123456",
          broadcastNickname: nickname,
          agreedTerms: true,
          agreedPrivacy: true,
          agreedRejoinRetention: true,
          rejoinRestrictionDaysShown: await shownDays(),
          rejoinRetentionVersionShown: REJOIN_RETENTION_CONSENT_VERSION,
          ...extra,
        },
        v.cookie,
      ),
      ctx(seller.slug),
    );
  const signup = async (person: Partial<Record<keyof typeof IDV_INPUT, string>> = {}, loginId = "buyer01@example.com", nickname = "카드왕", extra: Record<string, unknown> = {}) =>
    signupWith(await verified(person), loginId, nickname, extra);
  const withdraw = async (loginId = "buyer01@example.com") => {
    const m = await db.buyerMember.findFirstOrThrow({ where: { sellerId: seller.id, loginId, deletedAt: null } });
    expect(await withdrawBuyer(db, { sellerId: seller.id, buyerMemberId: m.id }, { password: "pw-123456" })).toEqual({ ok: true });
    return m;
  };
  const setPolicy = (body: unknown, cookie = sellerCookie) =>
    policyPut(new Request("http://localhost:3000/api/seller/member-policy", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
  const getPolicy = (cookie = sellerCookie) => policyGet(new Request("http://localhost:3000/api/seller/member-policy", { headers: { ...H, cookie } }));
  return { seller, owner, sellerCookie, verified, signupWith, signup, withdraw, setPolicy, getPolicy };
}

describe("구매자 재가입 제한", () => {
  it("동의 철회 기능 전(기본)에는 켤 수 없다: 켜기는 409 rejoin_restriction_unavailable이고 저장되지 않으며, 끄기는 된다. 조회는 켤 수 있는지 알려 준다", async () => {
    const s = await shop();
    REJOIN_RESTRICTION_CONFIG.available = false;
    try {
      expect(await (await s.getPolicy()).json()).toEqual({ policy: { rejoinRestrictionEnabled: false, rejoinRestrictionDays: 30 }, restrictionAvailable: false });
      const r = await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 90 });
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "rejoin_restriction_unavailable", message: "회원이 동의를 철회할 수 있는 화면이 준비되면 켤 수 있어요" });
      expect(await db.sellerMemberPolicy.count({ where: { sellerId: s.seller.id } })).toBe(0);
      expect((await s.setPolicy({ rejoinRestrictionEnabled: false, rejoinRestrictionDays: 30 })).status).toBe(200);
    } finally {
      REJOIN_RESTRICTION_CONFIG.available = true;
    }
  });

  it("설정은 기본 꺼짐·30일, 켜고 기간을 바꾸면 감사 로그를 남기고, 기간 1~365일 밖·켜기 값 없음은 400, 회원 권한 없는 직원은 403", async () => {
    const s = await shop();
    expect(await (await s.getPolicy()).json()).toEqual({ policy: { rejoinRestrictionEnabled: false, rejoinRestrictionDays: 30 }, restrictionAvailable: true });
    const r = await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 7 });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ policy: { rejoinRestrictionEnabled: true, rejoinRestrictionDays: 7 } });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "member_policy.rejoin_restriction", sellerId: s.seller.id } })).toMatchObject({
      before: { rejoinRestrictionEnabled: false, rejoinRestrictionDays: 30 },
      after: { rejoinRestrictionEnabled: true, rejoinRestrictionDays: 7, purgedRejoinBlocks: 0 },
    });
    // 기간을 빼면 지금 값 유지
    expect(await (await s.setPolicy({ rejoinRestrictionEnabled: true })).json()).toEqual({ policy: { rejoinRestrictionEnabled: true, rejoinRestrictionDays: 7 } });
    for (const bad of [{ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 0 }, { rejoinRestrictionEnabled: true, rejoinRestrictionDays: 366 }, { rejoinRestrictionEnabled: true, rejoinRestrictionDays: 1.5 }, { rejoinRestrictionDays: 7 }, { rejoinRestrictionEnabled: "true" }]) {
      const res = await s.setPolicy(bad);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_member_policy", message: "재가입 제한 기간은 1일에서 365일 사이로 정해 주세요" });
    }
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const staffLogin = await loginSeller(db, { email: staff.email, password: PASSWORD }, {});
    if (!staffLogin.ok) throw new Error(staffLogin.reason);
    expect((await s.setPolicy({ rejoinRestrictionEnabled: false }, `lo_seller=${staffLogin.token}`)).status).toBe(403);
    expect((await s.getPolicy(`lo_seller=${staffLogin.token}`)).status).toBe(403);
  });

  it("켜진 쇼핑몰: 탈퇴하면 CI 해시 하나만 기간 동안 남기고, 그동안 같은 사람은 403 rejoin_restricted(다시 가입할 수 있는 시각), 다른 사람은 가입된다", async () => {
    const s = await shop();
    await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 7 });
    expect((await s.signup()).status).toBe(201);
    const before = Date.now();
    const m = await s.withdraw();
    const blocks = await db.buyerRejoinBlock.findMany({ where: { sellerId: s.seller.id } });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].ciHash).toBe(m.ciHash);
    expect(blocks[0].expiresAt.getTime()).toBeGreaterThanOrEqual(before + 7 * DAY);
    expect(blocks[0].expiresAt.getTime()).toBeLessThan(Date.now() + 7 * DAY + 1000);
    // 회원 행은 지금처럼 비식별(CI 해시도 비움)
    expect(await db.buyerMember.findUniqueOrThrow({ where: { id: m.id } })).toMatchObject({ ciHash: "", name: "탈퇴한 회원" });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.withdraw", actorId: m.id } })).toMatchObject({ after: { rejoinBlockedUntil: blocks[0].expiresAt.toISOString() } });

    const again = await s.signup({}, "buyer02@example.com", "다른닉");
    expect(again.status).toBe(BUYER_SIGNUP_STATUS.rejoin_restricted);
    expect(again.status).toBe(403);
    const body = await again.json();
    expect(body).toMatchObject({ error: "rejoin_restricted", rejoinAvailableAt: blocks[0].expiresAt.toISOString() });
    expect(body.message).toBe("지금은 다시 가입할 수 없어요");
    expect(await db.buyerMember.count({ where: { sellerId: s.seller.id, deletedAt: null } })).toBe(0);

    expect((await s.signup({ name: "김다른", phone: "01099998888", birth7: "9001011" }, "other@example.com", "남닉")).status).toBe(201);
  });

  it("기간이 끝나면 다시 가입되고, 끝난 기록은 파기 함수가 지운다(다른 쇼핑몰·안 끝난 기록은 그대로)", async () => {
    const s = await shop();
    const t = await shop();
    for (const x of [s, t]) {
      await x.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 30 });
      expect((await x.signup()).status).toBe(201);
      await x.withdraw();
    }
    await db.buyerRejoinBlock.updateMany({ where: { sellerId: s.seller.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await s.signup({}, "back@example.com", "돌아옴")).status).toBe(201);
    // 가입 처리 때 이 쇼핑몰의 끝난 기록은 이미 지웠다
    expect(await purgeExpiredRejoinBlocks(db)).toBe(0);
    expect(await db.buyerRejoinBlock.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect(await db.buyerRejoinBlock.count({ where: { sellerId: t.seller.id } })).toBe(1);
    expect((await t.signup({}, "back@example.com", "돌아옴")).status).toBe(403);
  });

  it("재가입 제한 정보 보관 동의는 선택: 동의하지 않아도 가입되고 기간 스냅숏이 없어 탈퇴 뒤 바로 다시 가입된다. 동의하면 시각·문서 버전·기간을 남기고 탈퇴 뒤 기간 안 재가입은 거절된다", async () => {
    const s = await shop();
    await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 90 });
    // 불리언이 아니면 거부
    const bad = await s.signup({}, "buyer01@example.com", "카드왕", { agreedRejoinRetention: "true" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_rejoin_consent", message: "재가입 제한 정보 보관 동의 값을 다시 확인해 주세요" });
    // 미동의(값 없음·false): 보여 준 기간·버전이 틀려도 보지 않는다
    expect((await s.signup({}, "no1@example.com", "미동의1", { agreedRejoinRetention: undefined, rejoinRestrictionDaysShown: 1, rejoinRetentionVersionShown: "old" })).status).toBe(201);
    expect((await s.signup({ name: "김미동", birth7: "9001011", phone: "01033334444" }, "no2@example.com", "미동의2", { agreedRejoinRetention: false })).status).toBe(201);
    for (const x of await db.buyerMember.findMany({ where: { sellerId: s.seller.id } })) {
      expect(x).toMatchObject({ rejoinRestrictionDaysAgreed: null, rejoinRetentionAgreedAt: null, rejoinRetentionVersion: null });
    }
    // 미동의 회원은 탈퇴해도 CI 해시를 남기지 않고 바로 다시 가입된다
    await s.withdraw("no1@example.com");
    expect(await db.buyerRejoinBlock.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect((await s.signup({}, "again@example.com", "다시", { agreedRejoinRetention: false })).status).toBe(201);

    // 동의 회원: 스냅숏을 남기고 탈퇴 뒤 기간 안 재가입은 거절
    const t = await shop();
    await t.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 90 });
    expect((await t.signup()).status).toBe(201);
    const m = await db.buyerMember.findFirstOrThrow({ where: { sellerId: t.seller.id } });
    expect(m).toMatchObject({ rejoinRestrictionDaysAgreed: 90, rejoinRetentionAgreedAt: expect.any(Date), rejoinRetentionVersion: REJOIN_RETENTION_CONSENT_VERSION });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.signup", actorId: m.id } })).toMatchObject({
      after: { agreedRejoinRetention: true, rejoinRetentionVersion: REJOIN_RETENTION_CONSENT_VERSION, rejoinRestrictionDays: 90 },
    });
    await t.withdraw();
    const again = await t.signup({}, "again@example.com", "다시", { agreedRejoinRetention: false });
    expect(again.status).toBe(403);
    expect((await again.json()).error).toBe("rejoin_restricted");

    // 끈 쇼핑몰은 동의해도 남기지 않는다
    const off = await shop();
    expect((await off.signup({}, "b@example.com", "끈곳")).status).toBe(201);
    expect(await db.buyerMember.findFirstOrThrow({ where: { sellerId: off.seller.id } })).toMatchObject({ rejoinRestrictionDaysAgreed: null, rejoinRetentionVersion: null });
  });

  it("동의한 경우 화면이 보여 준 기간·문서 버전이 지금과 다르면 409(rejoin_policy_changed·consent_outdated)로 저장하지 않고, 같으면 그 기간으로 저장한다. 끈 쇼핑몰은 보지 않는다", async () => {
    const s = await shop();
    await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 30 });
    // 화면을 연 뒤 판매자가 365일로 바꿈: 화면은 30일을 보여 줬다
    await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 365 });
    for (const shown of [30, undefined, "365"]) {
      const r = await s.signup({}, "buyer01@example.com", "카드왕", { rejoinRestrictionDaysShown: shown });
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "rejoin_policy_changed", message: "재가입 제한 기간이 바뀌었어요. 바뀐 내용을 확인하고 다시 동의해 주세요" });
    }
    for (const version of ["2020-01-01.v0", undefined]) {
      const r = await s.signup({}, "buyer01@example.com", "카드왕", { rejoinRetentionVersionShown: version });
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "consent_outdated", message: "약관이 바뀌었어요. 다시 확인하고 동의해 주세요" });
    }
    expect(await db.buyerMember.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect((await s.signup({}, "buyer01@example.com", "카드왕", { rejoinRestrictionDaysShown: 365 })).status).toBe(201);
    expect((await db.buyerMember.findFirstOrThrow({ where: { sellerId: s.seller.id } })).rejoinRestrictionDaysAgreed).toBe(365);

    const off = await shop();
    expect((await off.signup({}, "o@example.com", "끔", { rejoinRestrictionDaysShown: 999, rejoinRetentionVersionShown: "old" })).status).toBe(201);
  });

  it("가입이 커밋된 뒤 응답이 끊기고 그사이 정책이 바뀌어도, 같은 요청 재시도는 정책 대조보다 먼저 만든 계정의 201과 세션을 받는다", async () => {
    const s = await shop();
    await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 30 });
    const v = await s.verified();
    const body = { rejoinRestrictionDaysShown: 30 };
    const first = await s.signupWith(v, "buyer01@example.com", "카드왕", body);
    expect(first.status).toBe(201);
    await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 365 });
    const retry = await s.signupWith(v, "buyer01@example.com", "카드왕", body);
    expect(retry.status).toBe(201);
    expect(cookieOf(retry, "lo_buyer")).toMatch(/^lo_buyer=.+/);
    expect(await db.buyerMember.count({ where: { sellerId: s.seller.id } })).toBe(1);
  });

  it("가입 때 제한이 꺼져 있었던 회원은 나중에 켠 뒤 탈퇴해도 CI 해시를 남기지 않고 바로 다시 가입된다", async () => {
    const s = await shop();
    expect((await s.signup()).status).toBe(201);
    expect((await db.buyerMember.findFirstOrThrow({ where: { sellerId: s.seller.id } })).rejoinRestrictionDaysAgreed).toBeNull();
    await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 30 });
    await s.withdraw();
    expect(await db.buyerRejoinBlock.count()).toBe(0);
    expect((await s.signup({}, "again@example.com", "다시")).status).toBe(201);
  });

  it("제한 기간은 가입 때 안내받은 기간과 탈퇴 때 설정 중 짧은 쪽이다", async () => {
    const s = await shop();
    await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 90 });
    expect((await s.signup()).status).toBe(201);
    expect((await db.buyerMember.findFirstOrThrow({ where: { sellerId: s.seller.id, loginId: "buyer01@example.com" } })).rejoinRestrictionDaysAgreed).toBe(90);
    expect((await s.signup({ name: "김둘", birth7: "9001011", phone: "01022223333" }, "two@example.com", "둘")).status).toBe(201);
    // 가입 뒤 더 길게 바꿔도 동의한 90일까지만
    await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 180 });
    let t = Date.now();
    await s.withdraw();
    let [b] = await db.buyerRejoinBlock.findMany({ where: { sellerId: s.seller.id } });
    expect(b.expiresAt.getTime() - t).toBeGreaterThanOrEqual(90 * DAY - 1000);
    expect(b.expiresAt.getTime() - t).toBeLessThan(90 * DAY + 5000);
    // 더 짧게 바꾸면 짧은 30일
    await s.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 30 });
    await db.buyerRejoinBlock.deleteMany();
    t = Date.now();
    await s.withdraw("two@example.com");
    [b] = await db.buyerRejoinBlock.findMany({ where: { sellerId: s.seller.id } });
    expect(b.expiresAt.getTime() - t).toBeGreaterThanOrEqual(30 * DAY - 1000);
    expect(b.expiresAt.getTime() - t).toBeLessThan(30 * DAY + 5000);
  });

  it("가입·탈퇴 처리 때 그 쇼핑몰의 기간이 끝난 제한 기록을 먼저 지운다(다른 쇼핑몰·안 끝난 기록은 그대로)", async () => {
    const s = await shop();
    const t = await shop();
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 86400_000);
    await db.buyerRejoinBlock.createMany({
      data: [
        { sellerId: s.seller.id, ciHash: "expired-a", expiresAt: past },
        { sellerId: s.seller.id, ciHash: "live-a", expiresAt: future },
        { sellerId: t.seller.id, ciHash: "expired-b", expiresAt: past },
      ],
    });
    expect((await s.signup({}, "a@example.com", "가")).status).toBe(201);
    expect((await db.buyerRejoinBlock.findMany({ orderBy: { ciHash: "asc" } })).map((b) => b.ciHash)).toEqual(["expired-b", "live-a"]);
    await db.buyerRejoinBlock.create({ data: { sellerId: t.seller.id, ciHash: "expired-c", expiresAt: past } });
    expect((await t.signup({}, "b@example.com", "나")).status).toBe(201);
    await t.withdraw("b@example.com");
    expect((await db.buyerRejoinBlock.findMany({ orderBy: { ciHash: "asc" } })).map((b) => b.ciHash)).toEqual(["live-a"]);
  });

  it("꺼진 쇼핑몰(기본): 탈퇴해도 CI 해시를 남기지 않고 같은 사람이 바로 다시 가입된다", async () => {
    const s = await shop();
    expect((await s.signup()).status).toBe(201);
    await s.withdraw();
    expect(await db.buyerRejoinBlock.count()).toBe(0);
    expect((await s.signup()).status).toBe(201);
  });

  it("제한을 끄면 그 쇼핑몰에 남긴 기록을 모두 지우고 바로 다시 가입되며, 끈 뒤 탈퇴는 기록하지 않는다. 다시 켜도 지운 기록은 돌아오지 않는다", async () => {
    const s = await shop();
    const t = await shop();
    for (const x of [s, t]) {
      await x.setPolicy({ rejoinRestrictionEnabled: true, rejoinRestrictionDays: 30 });
      expect((await x.signup()).status).toBe(201);
      await x.withdraw();
    }
    const off = await s.setPolicy({ rejoinRestrictionEnabled: false });
    expect(await off.json()).toEqual({ policy: { rejoinRestrictionEnabled: false, rejoinRestrictionDays: 30 } });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "member_policy.rejoin_restriction", sellerId: s.seller.id }, orderBy: { createdAt: "desc" } })).toMatchObject({
      after: { rejoinRestrictionEnabled: false, purgedRejoinBlocks: 1 },
    });
    expect(await db.buyerRejoinBlock.count({ where: { sellerId: s.seller.id } })).toBe(0);
    expect(await db.buyerRejoinBlock.count({ where: { sellerId: t.seller.id } })).toBe(1);
    expect((await s.signup({}, "b2@example.com", "닉2")).status).toBe(201);
    await s.withdraw("b2@example.com");
    expect(await db.buyerRejoinBlock.count({ where: { sellerId: s.seller.id } })).toBe(0);
    await s.setPolicy({ rejoinRestrictionEnabled: true });
    expect((await s.signup({}, "b3@example.com", "닉3")).status).toBe(201);
  });
});
