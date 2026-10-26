import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as loginRoute } from "../../app/api/shop/[slug]/auth/login/route";
import { POST as applyRoute } from "../../app/api/shop/[slug]/me/phone/route";
import { POST as startRoute } from "../../app/api/shop/[slug]/me/phone/verification/route";
import { POST as confirmRoute } from "../../app/api/shop/[slug]/me/phone/verification/confirm/route";
import { prisma } from "../../lib/server/db";
import { identityFeeKey } from "../../lib/server/identity/fee";
import { hashCi } from "../../lib/server/identity/ciHash";
import { purgeUnfinishedSignupVerifications } from "../../lib/server/buyers/signup";
import { PHONE_CHANGE_DAILY_LIMIT } from "../../lib/server/buyers/phoneChange";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

// 구매자 휴대폰 번호 변경 재인증(SH-024 2/2): 새 번호 본인확인 → CI가 회원과 같을 때만 번호·생년월일 변경,
// 하루 3번, 비용은 가입 본인확인과 같은 충전금 차감, 다른 기기 세션 유지, 본인확인 기록 비식별.
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
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0];
const PRICE = 70;
// 가짜 공급자는 이름·생년월일로 CI를 만든다(fake-ci:이름:생년월일7자리)
const PERSON = { name: "홍길동", phone: "01099998888", birth7: "9505051", carrier: "SKT", device: "MOBILE" };
const ciOf = (p: { name: string; birth7: string }) => hashCi(`fake-ci:${p.name}:${p.birth7}`);

async function login(slug: string, loginId: string) {
  const r = await loginRoute(new Request(`${BASE}/api/shop/${slug}/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ loginId, password: PASSWORD }) }), ctx(slug));
  return cookieOf(r, "lo_buyer");
}

// paid: 체험이 끝난 구독 쇼핑몰(충전금 차감 대상)
async function shop(opts: { paid?: boolean; balance?: number; charging?: boolean } = {}) {
  const { seller, grade } = await createSeller();
  if (opts.paid) {
    await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt: new Date("2000-01-01T00:00:00Z") } });
    const plan = await db.subscriptionPlan.upsert({ where: { code: "INTEGRATED" }, update: {}, create: { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000 } });
    await db.sellerSubscription.create({ data: { sellerId: seller.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), nextChargeAt: new Date(Date.now() + 20 * 86_400_000) } });
    await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, chargingEnabled: opts.charging ?? true }, update: { chargingEnabled: opts.charging ?? true } });
    await db.messageChannelPrice.upsert({ where: { channel: "IDENTITY_VERIFICATION" }, create: { channel: "IDENTITY_VERIFICATION", unitPrice: PRICE }, update: { unitPrice: PRICE } });
    await db.sellerMessageBalance.upsert({ where: { sellerId: seller.id }, create: { sellerId: seller.id, paidBalance: opts.balance ?? 1000 }, update: { paidBalance: opts.balance ?? 1000 } });
  }
  const buyer = await createLoginBuyer(seller.id, grade.id);
  await db.buyerMember.update({ where: { id: buyer.id }, data: { phone: "01012345678", name: "홍길동", birthDate: new Date("1990-01-01"), ciHash: ciOf(PERSON) } });
  const cookie = await login(seller.slug, buyer.loginId);
  const otherDevice = await login(seller.slug, buyer.loginId);
  const base = `/api/shop/${seller.slug}/me/phone`;
  const post = (path: string, body: unknown, c: string | undefined = cookie) => new Request(`${BASE}${base}${path}`, { method: "POST", headers: { ...H, ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) });
  const start = async (person: Record<string, unknown> = PERSON, c: string | undefined = cookie) => {
    const r = await startRoute(post("/verification", person, c), ctx(seller.slug));
    const body = await r.json();
    return { status: r.status, body, flow: cookieOf(r, "lo_bpc"), verificationId: body.verificationId as string };
  };
  const confirm = async (s: { flow: string; verificationId: string }, code = "000000") => confirmRoute(post("/verification/confirm", { verificationId: s.verificationId, code }, `${cookie}; ${s.flow}`), ctx(seller.slug));
  const apply = async (s: { flow: string; verificationId: string }, c: string = cookie) => {
    const r = await applyRoute(post("", { verificationId: s.verificationId }, `${c}; ${s.flow}`), ctx(seller.slug));
    return { status: r.status, body: await r.json() };
  };
  const member = () => db.buyerMember.findUniqueOrThrow({ where: { id: buyer.id } });
  const ledger = (verificationId: string) => db.sellerMessageLedger.findMany({ where: { sellerId: seller.id, idempotencyKey: identityFeeKey(verificationId) } });
  return { seller, buyer, cookie, otherDevice, start, confirm, apply, member, ledger };
}

describe("구매자 휴대폰 번호 변경 재인증", () => {
  it("새 번호 본인확인(CI 같음)을 마치면 번호·생년월일이 바뀌고, 다른 기기 로그인은 유지되며 본인확인 기록은 비식별된다", async () => {
    const s = await shop();
    const st = await s.start();
    expect(st.status).toBe(200);
    expect(st.flow).not.toBe("");
    // 확인 전에는 바꾸지 못한다
    expect((await s.apply(st)).body.error).toBe("verification_pending");
    expect((await s.confirm(st)).status).toBe(200);
    const r = await s.apply(st);
    expect(r).toEqual({ status: 200, body: { ok: true } });
    const m = await s.member();
    expect(m.phone).toBe(PERSON.phone);
    expect(m.birthDate?.toISOString().slice(0, 10)).toBe("1995-05-05");
    // 다른 기기 세션 유지
    const profile = await (await import("../../app/api/shop/[slug]/me/profile/route")).GET(new Request(`${BASE}/api/shop/${s.seller.slug}/me/profile`, { headers: { ...H, cookie: s.otherDevice } }), ctx(s.seller.slug));
    expect(profile.status).toBe(200);
    // 본인확인 기록: 식별 항목은 비우고 행·subjectId는 남긴다. 한 번만 쓴다.
    const v = await db.identityVerification.findUniqueOrThrow({ where: { id: st.verificationId } });
    expect(v).toMatchObject({ purpose: "BUYER_PHONE_CHANGE", status: "VERIFIED", subjectId: s.buyer.id, name: null, phone: null, requestedPhone: null, ciHash: null, ownerTokenHash: null });
    expect(v.anonymizedAt).not.toBeNull();
    expect(v.consumedAt).not.toBeNull();
    expect((await s.apply(st)).body.error).toBe("verification_invalid");
    expect(await db.auditLog.count({ where: { action: "buyer.profile.phone_change", targetId: s.buyer.id } })).toBe(1);
  });

  it("쇼핑몰이 일시 정지·준비 중이어도 기존 회원은 번호를 바꿀 수 있다(닉네임·비밀번호 변경과 같은 기준)", async () => {
    const s = await shop();
    await db.seller.update({ where: { id: s.seller.id }, data: { operatingState: "PAUSED" } });
    const st = await s.start();
    expect(st.status).toBe(200);
    expect((await s.confirm(st)).status).toBe(200);
    expect((await s.apply(st)).status).toBe(200);
    expect((await s.member()).phone).toBe(PERSON.phone);
  });

  it("지금과 같은 번호는 시작하지 않고, 본인확인한 분과 CI가 다르면 바꾸지 못한다", async () => {
    const s = await shop();
    const same = await s.start({ ...PERSON, phone: "01012345678" });
    expect(same.status).toBe(409);
    expect(same.body.error).toBe("same_phone");
    expect(await db.identityVerification.count({ where: { purpose: "BUYER_PHONE_CHANGE" } })).toBe(0);
    // 다른 사람 명의: 확인은 되지만 번호는 그대로
    const other = await s.start({ ...PERSON, name: "김철수" });
    expect((await s.confirm(other)).status).toBe(200);
    const r = await s.apply(other);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("identity_mismatch");
    expect((await s.member()).phone).toBe("01012345678");
  });

  it("다른 회원이 쓰는 번호는 409 phone_taken이고 본인확인 기록·번호는 바뀌지 않는다", async () => {
    const s = await shop();
    const g = await db.memberGrade.findFirstOrThrow({ where: { sellerId: s.seller.id } });
    await createLoginBuyer(s.seller.id, g.id).then((o) => db.buyerMember.update({ where: { id: o.id }, data: { phone: PERSON.phone } }));
    const st = await s.start();
    await s.confirm(st);
    const r = await s.apply(st);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("phone_taken");
    expect((await s.member()).phone).toBe("01012345678");
  });

  it("회원당 하루 3번까지만 시작한다. 다른 회원은 영향이 없다", async () => {
    const s = await shop();
    for (let i = 0; i < PHONE_CHANGE_DAILY_LIMIT; i++) expect((await s.start({ ...PERSON, phone: `0109999000${i}` })).status).toBe(200);
    const over = await s.start();
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("daily_limit_exceeded");
    const t = await shop();
    expect((await t.start()).status).toBe(200);
  });

  it("다른 쇼핑몰·로그아웃 상태·남의 본인확인으로는 바꾸지 못한다", async () => {
    const s = await shop();
    const t = await shop();
    expect((await s.start(PERSON, "")).status).toBe(401);
    const st = await s.start();
    await s.confirm(st);
    // 시작하지 않은 브라우저(쿠키 없음)는 쓸 수 없다
    expect((await s.apply({ flow: "", verificationId: st.verificationId })).body.error).toBe("verification_invalid");
    // 같은 쇼핑몰의 다른 회원은 남의 본인확인을 쓸 수 없다
    const g = await db.memberGrade.findFirstOrThrow({ where: { sellerId: s.seller.id } });
    const o = await createLoginBuyer(s.seller.id, g.id);
    const oc = await login(s.seller.slug, o.loginId);
    expect((await s.apply(st, oc)).body.error).toBe("verification_invalid");
    expect((await s.member()).phone).toBe("01012345678");
    expect(t.seller.id).not.toBe(s.seller.id);
  });
});

describe("구매자 휴대폰 번호 변경 비용", () => {
  it("체험 밖 쇼핑몰: 시작 때 차감을 잡고 변경 본인확인이 성공하면 확정한다. 체험 중에는 차감이 없다", async () => {
    const s = await shop({ paid: true });
    const st = await s.start();
    expect(await s.ledger(st.verificationId)).toEqual([expect.objectContaining({ type: "DEBIT", status: "PENDING", channel: "IDENTITY_VERIFICATION", paidAmount: -PRICE })]);
    await s.confirm(st);
    expect(await s.ledger(st.verificationId)).toEqual([expect.objectContaining({ status: "SUCCEEDED" })]);
    expect((await s.apply(st)).status).toBe(200);
    const trial = await shop();
    const tr = await trial.start();
    expect(await trial.ledger(tr.verificationId)).toEqual([]);
  });

  it("충전금이 없거나 충전 기능이 꺼져 있으면 번호 변경만 막는다(503), 본인확인 기록은 만들지 않는다", async () => {
    const empty = await shop({ paid: true, balance: 0 });
    const r = await empty.start();
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("phone_change_unavailable");
    const off = await shop({ paid: true, charging: false });
    expect((await off.start()).body.error).toBe("phone_change_unavailable");
    expect(await db.identityVerification.count({ where: { purpose: "BUYER_PHONE_CHANGE" } })).toBe(0);
    // 로그인·프로필 같은 다른 업무는 그대로
    expect((await login(empty.seller.slug, empty.buyer.loginId)).length).toBeGreaterThan(0);
  });
});

describe("끝나지 않은 번호 변경 본인확인 정리", () => {
  it("시간이 지난 미사용 기록은 식별 항목을 비우되 회원 연결(하루 횟수 계산)은 남긴다", async () => {
    const s = await shop();
    const st = await s.start();
    const later = new Date(Date.now() + 60 * 60_000);
    expect(await purgeUnfinishedSignupVerifications(db, later)).toBeGreaterThanOrEqual(1);
    const v = await db.identityVerification.findUniqueOrThrow({ where: { id: st.verificationId } });
    expect(v).toMatchObject({ name: null, requestedPhone: null, ciHash: null, ownerTokenHash: null, subjectId: s.buyer.id });
    expect(v.anonymizedAt).not.toBeNull();
    // 정리된 기록도 하루 횟수에 남는다
    for (let i = 0; i < PHONE_CHANGE_DAILY_LIMIT - 1; i++) expect((await s.start({ ...PERSON, phone: `0109999000${i}` })).status).toBe(200);
    expect((await s.start()).status).toBe(429);
  });
});
