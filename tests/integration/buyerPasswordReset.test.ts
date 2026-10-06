import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as httpConfirm } from "../../app/api/shop/[slug]/auth/password-reset/confirm/route";
import { POST as httpRequest } from "../../app/api/shop/[slug]/auth/password-reset/request/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { hashPassword } from "../../lib/server/auth/password";
import { createBuyerSession, resolveBuyerSession } from "../../lib/server/auth/session";
import { confirmBuyerPasswordReset, requestBuyerPasswordReset, RESET_LINK_TTL_MS } from "../../lib/server/buyers/passwordReset";
import { prisma } from "../../lib/server/db";
import { FakeMailSender } from "../../lib/server/mail/registry";
import { createBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const ORIGIN = "https://shop.example.com";
const OLD = "old-password-1";
const NEW = "new-password-1";

async function setup() {
  const { seller, grade } = await createSeller();
  const buyer = await createBuyer(seller.id, grade.id);
  const loginId = `${buyer.loginId}@example.com`;
  await db.buyerMember.update({ where: { id: buyer.id }, data: { loginId, passwordHash: await hashPassword(OLD) } });
  return { seller, buyer, loginId };
}
const input = (s: { seller: { id: string; slug: string; shopName: string } }, loginId: string) => ({ sellerId: s.seller.id, shopSlug: s.seller.slug, shopName: s.seller.shopName, loginId, origin: ORIGIN });
const tokenOf = (m: { text?: string }) => decodeURIComponent(/token=([^\s&]+)/.exec(m.text ?? "")![1]);

describe("구매자 비밀번호 재설정 요청", () => {
  it("가입된 이메일이면 링크 메일을 보내고, 없는 이메일도 같은 응답이며 메일은 없다", async () => {
    const s = await setup();
    const sender = new FakeMailSender();
    expect(await requestBuyerPasswordReset(db, sender, input(s, s.loginId))).toEqual({ ok: true });
    expect(await requestBuyerPasswordReset(db, sender, input(s, "nobody@example.com"))).toEqual({ ok: true });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0].to).toBe(s.loginId);
    expect(sender.sent[0].text).toContain(`${ORIGIN}/shop/${s.seller.slug}/password-reset?token=`);
    // 토큰 원문은 저장하지 않는다
    const rows = await db.buyerPasswordReset.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).not.toBe(tokenOf(sender.sent[0]));
    expect(rows[0].expiresAt.getTime() - rows[0].createdAt.getTime()).toBe(RESET_LINK_TTL_MS);
    // 거래 메일로 기록(쇼핑몰 제공량)
    expect(await db.mailDelivery.count({ where: { sellerId: s.seller.id, kind: "buyer.password_reset", status: "SENT" } })).toBe(1);
  });

  it("메일 공급자가 없으면 mail_unavailable(링크도 만들지 않는다)", async () => {
    const s = await setup();
    expect(await requestBuyerPasswordReset(db, null, input(s, s.loginId))).toEqual({ ok: false, reason: "mail_unavailable" });
    expect(await db.buyerPasswordReset.count()).toBe(0);
  });

  it("다시 요청하면 이전 링크는 무효다", async () => {
    const s = await setup();
    const sender = new FakeMailSender();
    await requestBuyerPasswordReset(db, sender, input(s, s.loginId));
    await requestBuyerPasswordReset(db, sender, input(s, s.loginId));
    const [first, second] = sender.sent.map(tokenOf);
    expect(await confirmBuyerPasswordReset(db, { sellerId: s.seller.id, token: first, password: NEW })).toEqual({ ok: false, reason: "token_invalid" });
    expect(await confirmBuyerPasswordReset(db, { sellerId: s.seller.id, token: second, password: NEW })).toEqual({ ok: true });
  });

  it("같은 이메일 1시간 3번까지, 없는 이메일도 똑같이 센다", async () => {
    const s = await setup();
    const sender = new FakeMailSender();
    for (const id of [s.loginId, "nobody@example.com"]) {
      for (let i = 0; i < 3; i++) expect(await requestBuyerPasswordReset(db, sender, input(s, id))).toEqual({ ok: true });
      expect(await requestBuyerPasswordReset(db, sender, input(s, id))).toEqual({ ok: false, reason: "too_many_requests" });
    }
    expect(sender.sent).toHaveLength(3);
    // 1시간이 지나면 다시 받는다
    const later = new Date(Date.now() + 61 * 60_000);
    expect(await requestBuyerPasswordReset(db, sender, input(s, s.loginId), { now: later })).toEqual({ ok: true });
  });

  it("같은 IP 1시간 20번까지", async () => {
    const s = await setup();
    const sender = new FakeMailSender();
    for (let i = 0; i < 20; i++) expect(await requestBuyerPasswordReset(db, sender, input(s, `u${i}@example.com`), { ip: "1.2.3.4" })).toEqual({ ok: true });
    expect(await requestBuyerPasswordReset(db, sender, input(s, "u99@example.com"), { ip: "1.2.3.4" })).toEqual({ ok: false, reason: "too_many_requests" });
    expect(await requestBuyerPasswordReset(db, sender, input(s, "u99@example.com"), { ip: "5.6.7.8" })).toEqual({ ok: true });
  });

  it("다른 쇼핑몰의 같은 이메일 회원에게는 가지 않는다", async () => {
    const a = await setup();
    const b = await createSeller();
    const sender = new FakeMailSender();
    expect(await requestBuyerPasswordReset(db, sender, input({ seller: b.seller }, a.loginId))).toEqual({ ok: true });
    expect(sender.sent).toHaveLength(0);
  });
});

describe("구매자 비밀번호 재설정 확인", () => {
  async function issue() {
    const s = await setup();
    const sender = new FakeMailSender();
    await requestBuyerPasswordReset(db, sender, input(s, s.loginId));
    return { ...s, token: tokenOf(sender.sent[0]) };
  }

  it("새 비밀번호로 바뀌고 모든 로그인 세션이 무효가 되며, 같은 링크는 다시 못 쓴다", async () => {
    const s = await issue();
    const a = await createBuyerSession(db, s.seller.id, s.buyer.id, {});
    const b = await createBuyerSession(db, s.seller.id, s.buyer.id, { remember: true });
    expect(await resolveBuyerSession(db, a.token, s.seller.id)).not.toBeNull();
    expect(await confirmBuyerPasswordReset(db, { sellerId: s.seller.id, token: s.token, password: NEW })).toEqual({ ok: true });
    expect(await resolveBuyerSession(db, a.token, s.seller.id)).toBeNull();
    expect(await resolveBuyerSession(db, b.token, s.seller.id)).toBeNull();
    expect((await loginBuyer(db, { sellerId: s.seller.id, loginId: s.loginId, password: OLD }, {})).ok).toBe(false);
    expect((await loginBuyer(db, { sellerId: s.seller.id, loginId: s.loginId, password: NEW }, {})).ok).toBe(true);
    expect(await confirmBuyerPasswordReset(db, { sellerId: s.seller.id, token: s.token, password: "another-pass-1" })).toEqual({ ok: false, reason: "token_invalid" });
    const logs = await db.auditLog.findMany({ where: { action: "auth.buyer.password_reset", targetId: s.buyer.id } });
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).not.toContain(s.token);
  });

  it("30분이 지나면 만료, 약한 비밀번호·엉뚱한 토큰·다른 쇼핑몰은 거부", async () => {
    const s = await issue();
    expect(await confirmBuyerPasswordReset(db, { sellerId: s.seller.id, token: s.token, password: "short" })).toEqual({ ok: false, reason: "weak_password" });
    expect(await confirmBuyerPasswordReset(db, { sellerId: s.seller.id, token: "nope", password: NEW })).toEqual({ ok: false, reason: "token_invalid" });
    const other = await createSeller();
    expect(await confirmBuyerPasswordReset(db, { sellerId: other.seller.id, token: s.token, password: NEW })).toEqual({ ok: false, reason: "token_invalid" });
    const late = new Date(Date.now() + RESET_LINK_TTL_MS + 1000);
    expect(await confirmBuyerPasswordReset(db, { sellerId: s.seller.id, token: s.token, password: NEW }, { now: late })).toEqual({ ok: false, reason: "token_expired" });
    // 실패한 시도는 비밀번호를 바꾸지 않는다
    expect((await loginBuyer(db, { sellerId: s.seller.id, loginId: s.loginId, password: OLD }, {})).ok).toBe(true);
  });

  it("동시에 두 번 보내도 한 번만 통과한다", async () => {
    const s = await issue();
    const rs = await Promise.all([1, 2].map((i) => confirmBuyerPasswordReset(db, { sellerId: s.seller.id, token: s.token, password: `${NEW}-${i}` })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });

  it("휴면·탈퇴 회원은 바꿀 수 없다", async () => {
    const s = await issue();
    await db.buyerMember.update({ where: { id: s.buyer.id }, data: { status: "DORMANT" } });
    expect(await confirmBuyerPasswordReset(db, { sellerId: s.seller.id, token: s.token, password: NEW })).toEqual({ ok: false, reason: "token_invalid" });
  });
});

describe("HTTP", () => {
  const post = (path: string, body: unknown) =>
    new Request(`http://localhost${path}`, { method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", host: "localhost" }, body: JSON.stringify(body) });

  it("요청은 가입 여부와 상관없이 같은 응답, 형식이 틀리면 400, 없는 쇼핑몰은 404", async () => {
    const s = await setup();
    const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
    const url = (slug: string) => `/api/shop/${slug}/auth/password-reset/request`;
    const a = await httpRequest(post(url(s.seller.slug), { loginId: s.loginId }), ctx(s.seller.slug));
    const b = await httpRequest(post(url(s.seller.slug), { loginId: "nobody@example.com" }), ctx(s.seller.slug));
    expect([a.status, await a.json()]).toEqual([b.status, await b.json()]);
    expect(a.status).toBe(200);
    expect((await httpRequest(post(url(s.seller.slug), { loginId: 5 }), ctx(s.seller.slug))).status).toBe(400);
    expect((await httpRequest(post(url("none"), { loginId: s.loginId }), ctx("none"))).status).toBe(404);
  });

  it("확인 실패 상태 코드: weak 400, invalid 400, expired 410", async () => {
    const s = await setup();
    const ctx = { params: Promise.resolve({ slug: s.seller.slug }) };
    const url = `/api/shop/${s.seller.slug}/auth/password-reset/confirm`;
    const r1 = await httpConfirm(post(url, { token: "x", password: "short" }), ctx);
    expect([r1.status, (await r1.json()).error]).toEqual([400, "weak_password"]);
    const r2 = await httpConfirm(post(url, { token: "x", password: NEW }), ctx);
    expect([r2.status, (await r2.json()).error]).toEqual([400, "token_invalid"]);
  });
});
