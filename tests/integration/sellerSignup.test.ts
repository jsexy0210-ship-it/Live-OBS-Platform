import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as applyRoute } from "../../app/api/seller-signup/apply/route";
import { POST as confirmRoute } from "../../app/api/seller-signup/verification/confirm/route";
import { POST as startRoute } from "../../app/api/seller-signup/verification/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { FakeIdentityProvider } from "../../lib/server/identity/provider";
import { identityProvider } from "../../lib/server/identity/registry";
import { SIGNUP_VERIFY_DAILY_LIMIT_PER_IP, applyForSeller, startSellerSignupVerification, type ApplyInput } from "../../lib/server/sellers/application";
import { TRIAL_DAYS, approveSeller, listSellersToReview, rejectSeller } from "../../lib/server/sellers/approval";
import {
  FakeBusinessStatusProvider,
  FakeMailOrderProvider,
  UnavailableBusinessStatusProvider,
  UnavailableMailOrderProvider,
} from "../../lib/server/sellers/businessCheck";
import { IDV_INPUT, confirmIdv, createAdmin, db, resetDb, startIdv } from "./helpers";

beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
  process.env.BUSINESS_STATUS_PROVIDER = "fake";
  process.env.MAIL_ORDER_PROVIDER = "fake";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const identity = new FakeIdentityProvider();

// 대표자 휴대폰 본인확인을 마친 인증 기록과 시작한 브라우저 값
async function verified(ci: string, name = "김대표") {
  const { verification, ownerToken } = await startIdv(identity, { purpose: "SELLER_REPRESENTATIVE", sellerId: null, person: { name, phone: "01011112222" } });
  identity.complete(verification.requestId, { ci, name, phone: "01011112222", birthDate: new Date("1985-01-01") });
  const r = await confirmIdv(identity, verification, ownerToken);
  if (!r.ok) throw new Error(r.reason);
  return { verificationId: verification.id, ownerToken };
}

// 검증 숫자가 맞는 서로 다른 사업자등록번호(신청마다 다르게, 같은 번호 중복 점검과 섞이지 않게)
function businessNumberOf(seq: number): string {
  const head = String(300000000 + seq).padStart(9, "0");
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  const d = Array.from(head, Number);
  const sum = w.reduce((a, wi, i) => a + d[i] * wi, 0) + Math.floor((d[8] * 5) / 10);
  return head + String((10 - (sum % 10)) % 10);
}

let mailOrder = new FakeMailOrderProvider();
beforeEach(() => {
  mailOrder = new FakeMailOrderProvider();
});

let n = 0;
function form(v: { verificationId: string; ownerToken: string }, extra: Partial<ApplyInput> = {}): ApplyInput {
  n++;
  return {
    ...v,
    email: `owner${n}@example.com`,
    password: "seller-pass-1",
    shopName: `카드샵 ${n}`,
    slug: `card-shop-${n}`,
    businessNumber: businessNumberOf(n),
    companyName: "주식회사 카드",
    openedOn: "2020-01-01",
    mailOrderNumber: "제2024-서울강남-01234호",
    ...extra,
  };
}

async function adminCtx(role: "SUPER_ADMIN" | "CS" | "READ_ONLY" = "SUPER_ADMIN") {
  const admin = await createAdmin(role);
  const s = await createAdminSession(db, admin.id, {});
  return (await resolveAdminSession(db, s.token))!;
}

describe("자동 점검 통과 → 자동 승인", () => {
  it("모두 통과하면 바로 운영 중, 체험하기 = 승인 + 14일, 기본 등급 5개, 대표자 계정으로 로그인된다", async () => {
    const business = new FakeBusinessStatusProvider();
    const f = form(await verified("CI-1"));
    const r = await applyForSeller(db, { business, mailOrder }, f);
    expect(r).toMatchObject({ ok: true, approved: true, reviewReasons: [] });
    if (!r.ok) return;
    const seller = await db.seller.findUniqueOrThrow({ where: { id: r.sellerId } });
    expect(seller).toMatchObject({ status: "ACTIVE", approvedByAdminId: null, reviewReasons: [] });
    expect(seller.trialEndsAt!.getTime() - seller.approvedAt!.getTime()).toBe(TRIAL_DAYS * DAY);
    expect(TRIAL_DAYS).toBe(14);
    expect(seller.businessInfo).toMatchObject({
      businessNumber: f.businessNumber,
      representativeName: "김대표",
      openedOn: "20200101",
      mailOrderNumber: "제2024-서울강남-01234호",
      businessStatus: "ACTIVE",
      businessInfoValid: true,
      mailOrderStatus: "NORMAL",
    });
    expect(await db.memberGrade.count({ where: { sellerId: seller.id } })).toBe(5);
    const owner = await db.sellerUser.findFirstOrThrow({ where: { sellerId: seller.id } });
    expect(owner).toMatchObject({ isOwner: true, name: "김대표", email: f.email });
    expect((await loginSeller(db, { email: f.email, password: f.password }, {})).ok).toBe(true);
    const actions = (await db.auditLog.findMany({ where: { sellerId: seller.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["seller.apply", "seller.auto_approve"]));
    // CI 원문은 저장하지 않는다
    expect(JSON.stringify(seller)).not.toContain("CI-1");
  });
});

describe("자동 점검에 걸림 → 「확인 필요」", () => {
  it("휴업·폐업, 조회 실패, 통신판매업 신고번호 없음·형식 틀림이면 승인 대기로 두고 사유를 남긴다", async () => {
    const business = new FakeBusinessStatusProvider();
    business.set("1234567891", "CLOSED");
    business.fail("2208162517");
    const closed = await applyForSeller(db, { business, mailOrder }, form(await verified("CI-2"), { businessNumber: "1234567891" }));
    const failed = await applyForSeller(db, { business, mailOrder }, form(await verified("CI-3"), { businessNumber: "2208162517" }));
    const noMail = await applyForSeller(db, { business, mailOrder }, form(await verified("CI-4"), { mailOrderNumber: null }));
    const badMail = await applyForSeller(db, { business, mailOrder }, form(await verified("CI-5"), { mailOrderNumber: "신고 준비 중" }));
    expect(closed).toMatchObject({ ok: true, approved: false, reviewReasons: ["business_not_active"] });
    expect(failed).toMatchObject({ ok: true, approved: false, reviewReasons: ["business_lookup_failed"] });
    expect(noMail).toMatchObject({ ok: true, approved: false, reviewReasons: ["mail_order_number_invalid"] });
    expect(badMail).toMatchObject({ ok: true, approved: false, reviewReasons: ["mail_order_number_invalid"] });
    expect(await db.seller.count({ where: { status: "PENDING" } })).toBe(4);

    // 승인 대기 판매자는 로그인할 수 없다
    const owner = await db.sellerUser.findFirstOrThrow({ where: { seller: { id: (closed as { sellerId: string }).sellerId } } });
    expect(await loginSeller(db, { email: owner.email, password: "seller-pass-1" }, {})).toEqual({ ok: false, reason: "seller_pending" });
  });

  it("마스터 「확인 필요」 목록에 보이고, 승인하면 사유를 지우고 체험하기를 시작, 반려는 사유 필수", async () => {
    const business = new FakeBusinessStatusProvider();
    business.set("1234567891", "SUSPENDED");
    const a = await applyForSeller(db, { business, mailOrder }, form(await verified("CI-6"), { businessNumber: "1234567891" }));
    const b = await applyForSeller(db, { business, mailOrder }, form(await verified("CI-7"), { mailOrderNumber: null }));
    if (!a.ok || !b.ok) throw new Error("apply failed");

    const reader = await adminCtx("READ_ONLY");
    const list = await listSellersToReview(db, reader);
    expect(list.map((s) => [s.id, s.reviewReasons])).toEqual([
      [a.sellerId, ["business_not_active"]],
      [b.sellerId, ["mail_order_number_invalid"]],
    ]);

    const admin = await adminCtx();
    expect(await approveSeller(db, admin, a.sellerId)).toMatchObject({ ok: true });
    expect(await db.seller.findUniqueOrThrow({ where: { id: a.sellerId } })).toMatchObject({ status: "ACTIVE", reviewReasons: [] });
    expect(await rejectSeller(db, admin, b.sellerId, " ")).toEqual({ ok: false, reason: "reason_required" });
    expect(await rejectSeller(db, admin, b.sellerId, "통신판매업 신고 후 다시 신청해 주세요")).toEqual({ ok: true });
    expect(await db.seller.findUniqueOrThrow({ where: { id: b.sellerId } })).toMatchObject({
      status: "REJECTED",
      rejectedReason: "통신판매업 신고 후 다시 신청해 주세요",
      rejectedAt: expect.any(Date),
      suspendedReason: null,
    });
    await expect(rejectSeller(db, await adminCtx("CS"), a.sellerId, "x")).rejects.toMatchObject({ status: 403 });
    expect(await listSellersToReview(db, reader)).toEqual([]);
  });
});

describe("거부되는 신청", () => {
  it("대표자 1명당 쇼핑몰 1개: 같은 CI로 두 번째 신청은 거부, 반려된 뒤에는 다시 신청할 수 있다", async () => {
    const business = new FakeBusinessStatusProvider();
    const first = await applyForSeller(db, { business, mailOrder }, form(await verified("CI-8"), { mailOrderNumber: null }));
    expect(first.ok).toBe(true);
    expect(await applyForSeller(db, { business, mailOrder }, form(await verified("CI-8")))).toEqual({ ok: false, reason: "representative_has_shop" });
    await rejectSeller(db, await adminCtx(), (first as { sellerId: string }).sellerId, "보완 필요");
    expect(await applyForSeller(db, { business, mailOrder }, form(await verified("CI-8")))).toMatchObject({ ok: true, approved: true });
  });

  it("같은 CI로 동시에 신청해도 하나만 만들어진다", async () => {
    const business = new FakeBusinessStatusProvider();
    const [v1, v2] = [await verified("CI-9"), await verified("CI-9")];
    const rs = await Promise.all([applyForSeller(db, { business, mailOrder }, form(v1)), applyForSeller(db, { business, mailOrder }, form(v2))]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, reason: "representative_has_shop" });
    expect(await db.seller.count()).toBe(1);
  });

  it("본인인증: 다른 브라우저·이미 쓴 인증·30분 지난 인증·다른 용도는 거부", async () => {
    const business = new FakeBusinessStatusProvider();
    const v = await verified("CI-10");
    expect(await applyForSeller(db, { business, mailOrder }, form({ ...v, ownerToken: "other" }))).toEqual({ ok: false, reason: "verification_invalid" });
    const late = await applyForSeller(db, { business, mailOrder }, { ...form(v), now: new Date(Date.now() + 31 * 60_000) });
    expect(late).toEqual({ ok: false, reason: "verification_invalid" });
    expect((await applyForSeller(db, { business, mailOrder }, form(v))).ok).toBe(true);
    expect(await applyForSeller(db, { business, mailOrder }, form(v))).toEqual({ ok: false, reason: "verification_invalid" });

    const { verification, ownerToken } = await startIdv(identity, { purpose: "PASSWORD_RESET", sellerId: null, person: { phone: "01000000000" } });
    identity.complete(verification.requestId, { ci: "CI-11", name: "x", phone: "01000000000", birthDate: new Date("1990-01-01") });
    expect((await confirmIdv(identity, verification, ownerToken)).ok).toBe(true);
    expect(await applyForSeller(db, { business, mailOrder }, form({ verificationId: verification.id, ownerToken }))).toEqual({ ok: false, reason: "verification_invalid" });
  });

  it("입력: 주소 이름 형식·예약어·중복, 사업자등록번호 검증 숫자, 짧은 비밀번호", async () => {
    const business = new FakeBusinessStatusProvider();
    const v = await verified("CI-12");
    expect(await applyForSeller(db, { business, mailOrder }, form(v, { slug: "Admin" }))).toEqual({ ok: false, reason: "invalid_slug" });
    expect(await applyForSeller(db, { business, mailOrder }, form(v, { slug: "a" }))).toEqual({ ok: false, reason: "invalid_slug" });
    expect(await applyForSeller(db, { business, mailOrder }, form(v, { businessNumber: "124-81-00999" }))).toEqual({ ok: false, reason: "invalid_business_number" });
    expect(await applyForSeller(db, { business, mailOrder }, form(v, { password: "short" }))).toEqual({ ok: false, reason: "weak_password" });
    expect(await applyForSeller(db, { business, mailOrder }, form(v, { email: "not-an-email" }))).toEqual({ ok: false, reason: "invalid_input" });
    await applyForSeller(db, { business, mailOrder }, form(await verified("CI-13"), { slug: "taken-shop" }));
    expect(await applyForSeller(db, { business, mailOrder }, form(v, { slug: "taken-shop" }))).toEqual({ ok: false, reason: "slug_taken" });
    // 거부된 입력으로는 인증이 소진되지 않는다
    expect((await applyForSeller(db, { business, mailOrder }, form(v))).ok).toBe(true);
  });
});

describe("HTTP: 가입 신청", () => {
  const BASE = "http://localhost:3000";
  const post = (path: string, body: unknown, cookie?: string) =>
    new Request(BASE + path, {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost:3000", origin: BASE, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  const rep = { ...IDV_INPUT, name: "박대표", phone: "010-3333-4444" };
  // 시작 응답의 요청 기록에 가짜 공급자 명의를 정하고, 인증번호 확인 라우트로 확정한다
  const confirmHttp = async (verificationId: string, cookie: string) => {
    const { requestId } = await db.identityVerification.findUniqueOrThrow({ where: { id: verificationId } });
    (identityProvider() as FakeIdentityProvider).complete(requestId, { ci: "CI-HTTP", name: "박대표", phone: "01033334444", birthDate: new Date("1980-02-02") });
    const r = await confirmRoute(post("/api/seller-signup/verification/confirm", { verificationId, code: "000000" }, cookie));
    expect(r.status).toBe(200);
  };

  it("휴대폰 본인확인 시작 → 인증번호 확인 → 신청하면 자동 승인되고, 쿠키 없이는 거부", async () => {
    const start = await startRoute(post("/api/seller-signup/verification", rep));
    expect(start.status).toBe(200);
    const setCookie = start.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^lo_sidv=/);
    expect(setCookie.toLowerCase()).toContain("path=/api/seller-signup");
    const cookie = setCookie.split(";")[0];
    const { verificationId } = await start.json();
    await confirmHttp(verificationId, cookie);

    const body = {
      openedOn: "20200101",
      verificationId,
      email: "http-owner@example.com",
      password: "seller-pass-1",
      shopName: "HTTP 카드",
      slug: "http-card",
      businessNumber: "124-81-00998",
      companyName: "HTTP 상사",
      mailOrderNumber: "제2025-부산해운대-00077호",
    };
    expect((await applyRoute(post("/api/seller-signup/apply", body))).status).toBe(400);
    const res = await applyRoute(post("/api/seller-signup/apply", body, cookie));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ approved: true, reviewReasons: [], resumed: false });
    expect((await db.seller.findUniqueOrThrow({ where: { slug: "http-card" } })).status).toBe("ACTIVE");

    // 같은 대표자가 또 신청하면 409와 정해진 문구(다른 쇼핑몰 이름 없음)
    const again = await startRoute(post("/api/seller-signup/verification", rep));
    const cookie2 = (again.headers.get("set-cookie") ?? "").split(";")[0];
    const second = await again.json();
    await confirmHttp(second.verificationId, cookie2);
    const dup = await applyRoute(post("/api/seller-signup/apply", { ...body, verificationId: second.verificationId, slug: "http-card-2" }, cookie2));
    expect(dup.status).toBe(409);
    const dupBody = await dup.json();
    expect(dupBody).toEqual({ error: "representative_has_shop", message: "이미 운영 중인 쇼핑몰이 있어요 · 한 대표자는 쇼핑몰 하나만 열 수 있어요" });
    expect(JSON.stringify(dupBody)).not.toContain("HTTP 카드");
  });

  it("attemptKey로 다시 시작하면 같은 본인확인·같은 쿠키 값을 돌려주고 문자·하루 횟수를 다시 쓰지 않는다. 확인을 마친 뒤 같은 키는 409, 키 형식이 틀리면 400", async () => {
    const key = crypto.randomUUID();
    const sentBefore = (identityProvider() as FakeIdentityProvider).sent.length;
    const first = await startRoute(post("/api/seller-signup/verification", { ...rep, attemptKey: key }));
    expect(first.status).toBe(200);
    const cookie = (first.headers.get("set-cookie") ?? "").split(";")[0];
    const { verificationId } = await first.json();
    // 응답이 끊겨 쿠키 없이 같은 키로 다시 보낸다
    const again = await startRoute(post("/api/seller-signup/verification", { ...rep, attemptKey: key }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ verificationId });
    expect((again.headers.get("set-cookie") ?? "").split(";")[0]).toBe(cookie);
    expect(await db.identityVerification.count({ where: { purpose: "SELLER_REPRESENTATIVE" } })).toBe(1);
    expect((identityProvider() as FakeIdentityProvider).sent.length - sentBefore).toBe(1);
    await confirmHttp(verificationId, cookie);
    const done = await startRoute(post("/api/seller-signup/verification", { ...rep, attemptKey: key }));
    expect(done.status).toBe(409);
    expect((await done.json()).error).toBe("already_verified");
    // 다른 키면 새로 시작하고, 형식이 틀린 키는 400
    expect((await startRoute(post("/api/seller-signup/verification", { ...rep, attemptKey: crypto.randomUUID() }))).status).toBe(200);
    expect(await db.identityVerification.count({ where: { purpose: "SELLER_REPRESENTATIVE" } })).toBe(2);
    expect((await startRoute(post("/api/seller-signup/verification", { ...rep, attemptKey: "abc" }))).status).toBe(400);
  });

  it("같은 attemptKey로 동시에 시작해도 기록·문자는 한 번이다(보내는 중에 온 요청은 409 start_in_progress와 문구)", async () => {
    const key = crypto.randomUUID();
    const rs = await Promise.all([1, 2, 3].map(() => startRoute(post("/api/seller-signup/verification", { ...rep, attemptKey: key }))));
    const bodies = await Promise.all(rs.map((r) => r.json()));
    expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    for (const [i, r] of rs.entries()) if (r.status === 409) expect(bodies[i]).toEqual({ error: "start_in_progress", message: "인증번호를 보내고 있어요. 잠시 뒤 다시 시도해 주세요" });
    expect(new Set(bodies.filter((_, i) => rs[i].status === 200).map((x) => x.verificationId)).size).toBe(1);
    const all = await db.identityVerification.findMany({ where: { purpose: "SELLER_REPRESENTATIVE" } });
    expect(all).toHaveLength(1);
    expect(all[0].sendCount).toBe(1);
  });

  it("신청이 커밋된 뒤 응답이 끊겨 같은 요청을 다시 보내면 새로 만들지 않고 같은 결과(200·resumed)를 준다. 비밀번호·주소가 다르거나 다른 브라우저면 verification_invalid", async () => {
    const start = await startRoute(post("/api/seller-signup/verification", rep));
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    const { verificationId } = await start.json();
    await confirmHttp(verificationId, cookie);
    const body = {
      openedOn: "20200101",
      verificationId,
      email: "retry-owner@example.com",
      password: "seller-pass-1",
      shopName: "재시도 카드",
      slug: "retry-card",
      businessNumber: "124-81-00998",
      companyName: "재시도 상사",
      mailOrderNumber: "제2025-부산해운대-00077호",
    };
    const first = await applyRoute(post("/api/seller-signup/apply", body, cookie));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ approved: true, reviewReasons: [], resumed: false });
    // 성공 응답은 흐름 쿠키를 지우지 않는다(응답이 잘려 결과를 못 받은 브라우저가 같은 쿠키로 다시 보내 같은 결과를 받게)
    expect(first.headers.getSetCookie().filter((c) => c.startsWith("lo_sidv="))).toEqual([]);
    const again = await applyRoute(post("/api/seller-signup/apply", body, cookie));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ approved: true, reviewReasons: [], resumed: true });
    expect(again.headers.getSetCookie().filter((c) => c.startsWith("lo_sidv="))).toEqual([]);
    // 확인 뒤 15분이 지나 본인확인 유효 시간이 끝났어도 같은 브라우저의 같은 요청은 재개 결과를 받는다(새 신청은 만들지 않음)
    await db.identityVerification.update({ where: { id: verificationId }, data: { verifiedAt: new Date(Date.now() - 15 * 60_000), expiresAt: new Date(Date.now() - 60_000) } });
    const late = await applyRoute(post("/api/seller-signup/apply", body, cookie));
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ approved: true, reviewReasons: [], resumed: true });
    expect(await db.seller.count()).toBe(1);
    expect(await db.sellerUser.count()).toBe(1);
    expect(await db.auditLog.count({ where: { action: "seller.apply" } })).toBe(1);
    for (const [b, c] of [
      [{ ...body, password: "other-pass-1" }, cookie],
      [{ ...body, slug: "retry-card-2" }, cookie],
      [{ ...body, email: "someone@example.com" }, cookie],
      [body, undefined],
    ] as const) {
      const r = await applyRoute(post("/api/seller-signup/apply", b, c));
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(await r.json()).toEqual({ error: "verification_invalid" });
    }
  });

  it("확인 필요(승인 대기)로 끝난 신청의 재시도는 그 사유를 그대로 돌려준다", async () => {
    const start = await startRoute(post("/api/seller-signup/verification", rep));
    const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
    const { verificationId } = await start.json();
    await confirmHttp(verificationId, cookie);
    const body = { openedOn: "20200101", verificationId, email: "wait@example.com", password: "seller-pass-1", shopName: "대기 카드", slug: "wait-card", businessNumber: "124-81-00998", companyName: "대기 상사" };
    const first = await (await applyRoute(post("/api/seller-signup/apply", body, cookie))).json();
    expect(first.approved).toBe(false);
    expect(first.reviewReasons.length).toBeGreaterThan(0);
    const again = await applyRoute(post("/api/seller-signup/apply", body, cookie));
    expect(await again.json()).toEqual({ ...first, resumed: true });
  });
});

describe("MASTER 결정 반영", () => {
  it("국세청 조회 키가 없거나 연동 전이면 조회 실패로 보고 자동 승인하지 않는다", async () => {
    const r = await applyForSeller(db, { business: new UnavailableBusinessStatusProvider(), mailOrder }, form(await verified("CI-NOKEY")));
    expect(r).toMatchObject({ ok: true, approved: false, reviewReasons: ["business_lookup_failed"] });
  });

  it("가입 휴대폰 본인확인 시작은 같은 IP에서 하루 10회까지, 다른 IP는 따로 센다", async () => {
    for (let i = 0; i < SIGNUP_VERIFY_DAILY_LIMIT_PER_IP; i++) {
      expect((await startSellerSignupVerification(db, identity, IDV_INPUT, { ip: "203.0.113.7" })).ok).toBe(true);
    }
    expect(await startSellerSignupVerification(db, identity, IDV_INPUT, { ip: "203.0.113.7" })).toEqual({ ok: false, reason: "daily_limit_exceeded" });
    expect((await startSellerSignupVerification(db, identity, IDV_INPUT, { ip: "203.0.113.8" })).ok).toBe(true);
    expect(await db.auditLog.count({ where: { action: "seller.signup.verify_limited" } })).toBe(1);
    // 어제 시작한 건은 세지 않는다(KST 자정 초기화)
    await db.identityVerification.updateMany({ where: { requestIp: "203.0.113.7" }, data: { createdAt: new Date(Date.now() - 2 * DAY) } });
    expect((await startSellerSignupVerification(db, identity, IDV_INPUT, { ip: "203.0.113.7" })).ok).toBe(true);
  });

  it("같은 IP에서 동시에 시작해도 10회를 넘지 않는다", async () => {
    const rs = await Promise.all(Array.from({ length: 15 }, () => startSellerSignupVerification(db, identity, IDV_INPUT, { ip: "198.51.100.1" })));
    expect(rs.filter((r) => r.ok)).toHaveLength(SIGNUP_VERIFY_DAILY_LIMIT_PER_IP);
  });
});

describe("MASTER 검수 P1: 사업자 대조·통신판매업 조회", () => {
  it("다른 사람이 같은 사업자번호로 신청하면 대표자명 불일치·같은 번호 중복으로 「확인 필요」(자동 승인 안 함)", async () => {
    const business = new FakeBusinessStatusProvider();
    // 국세청 등록: 124-81-00998은 대표자 김대표, 개업일 2020-01-01
    business.register("1248100998", { representativeName: "김대표", openedOn: "20200101" });
    const owner = await applyForSeller(db, { business, mailOrder }, form(await verified("CI-REAL", "김대표"), { businessNumber: "124-81-00998", companyName: "삼성" }));
    expect(owner).toMatchObject({ ok: true, approved: true });
    const other = await applyForSeller(
      db,
      { business, mailOrder },
      form(await verified("CI-OTHER", "이아무개"), { businessNumber: "124-81-00998", companyName: "아무개상사" }),
    );
    expect(other).toMatchObject({ ok: true, approved: false });
    if (!other.ok) return;
    expect(other.reviewReasons).toEqual(expect.arrayContaining(["business_info_mismatch", "business_duplicate"]));
    expect((await db.seller.findUniqueOrThrow({ where: { id: other.sellerId } })).status).toBe("PENDING");
  });

  it("개업일자가 다르면 진위확인 불일치로 「확인 필요」, 개업일자 형식이 틀리면 신청을 받지 않는다", async () => {
    const business = new FakeBusinessStatusProvider();
    const bn = businessNumberOf(9001);
    business.register(bn, { representativeName: "김대표", openedOn: "20190505" });
    expect(await applyForSeller(db, { business, mailOrder }, form(await verified("CI-DATE"), { businessNumber: bn }))).toMatchObject({
      ok: true,
      approved: false,
      reviewReasons: ["business_info_mismatch"],
    });
    expect(await applyForSeller(db, { business, mailOrder }, form(await verified("CI-DATE2"), { openedOn: "2019-02-30" }))).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("같은 사업자번호 두 번째 신청은 대표자가 같아도(대조 일치) 「확인 필요」, 동시에 내도 둘 다 자동 승인되지는 않는다", async () => {
    const business = new FakeBusinessStatusProvider();
    const bn = businessNumberOf(9002);
    const rs = await Promise.all([
      applyForSeller(db, { business, mailOrder }, form(await verified("CI-D1"), { businessNumber: bn })),
      applyForSeller(db, { business, mailOrder }, form(await verified("CI-D2"), { businessNumber: bn })),
    ]);
    expect(rs.filter((r) => r.ok && r.approved)).toHaveLength(1);
    expect(rs.filter((r) => r.ok && !r.approved && r.reviewReasons.includes("business_duplicate"))).toHaveLength(1);
  });

  it("통신판매업 신고: 등록 없음·사업자번호 불일치·영업 정상 아님·조회 실패는 각각 「확인 필요」", async () => {
    const business = new FakeBusinessStatusProvider();
    const cases: [string, Parameters<FakeMailOrderProvider["register"]>[1] | "fail", string][] = [
      ["제2024-서울강남-10001호", null, "mail_order_not_registered"],
      ["제2024-서울강남-10002호", { businessNumber: "1112223339" }, "mail_order_not_registered"],
      ["제2024-서울강남-10003호", { businessNumber: "", status: "CLOSED" }, "mail_order_not_active"],
      ["제2024-서울강남-10004호", "fail", "mail_order_lookup_failed"],
    ];
    for (const [i, [number, record, reason]] of cases.entries()) {
      const f = form(await verified(`CI-MO-${i}`), { mailOrderNumber: number });
      if (record === "fail") mailOrder.fail(number);
      else mailOrder.register(number, record && record.businessNumber === "" ? { ...record, businessNumber: normalize(f.businessNumber) } : record);
      expect(await applyForSeller(db, { business, mailOrder }, f)).toMatchObject({ ok: true, approved: false, reviewReasons: [reason] });
    }
  });

  it("공정위 조회 키가 없거나(연동 전) fake를 명시하지 않으면 조회 실패로 「확인 필요」", async () => {
    const r = await applyForSeller(
      db,
      { business: new FakeBusinessStatusProvider(), mailOrder: new UnavailableMailOrderProvider() },
      form(await verified("CI-NOFTC")),
    );
    expect(r).toMatchObject({ ok: true, approved: false, reviewReasons: ["mail_order_lookup_failed"] });
    const prev = process.env.MAIL_ORDER_PROVIDER;
    delete process.env.MAIL_ORDER_PROVIDER;
    try {
      const { mailOrderProvider } = await import("../../lib/server/sellers/businessCheck");
      expect(mailOrderProvider().name).toBe("unavailable");
    } finally {
      process.env.MAIL_ORDER_PROVIDER = prev;
    }
  });
});

const normalize = (bn: string) => bn.replace(/-/g, "");
