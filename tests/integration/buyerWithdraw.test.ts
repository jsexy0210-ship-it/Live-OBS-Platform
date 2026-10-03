import type { OrderStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as addressesRoute } from "../../app/api/shop/[slug]/addresses/route";
import { POST as loginRoute } from "../../app/api/shop/[slug]/auth/login/route";
import { POST as withdrawRoute } from "../../app/api/shop/[slug]/me/withdraw/route";
import { WITHDRAW_MESSAGES } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const login = await loginRoute(
    new Request(`http://localhost:3000/api/shop/${seller.slug}/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ loginId: buyer.loginId, password: PASSWORD }) }),
    ctx(seller.slug),
  );
  const cookie = (login.headers.getSetCookie().find((c) => c.startsWith("lo_buyer=")) ?? "").split(";")[0];
  const withdraw = (password: unknown, c = cookie, slug = seller.slug) =>
    withdrawRoute(new Request(`http://localhost:3000/api/shop/${slug}/me/withdraw`, { method: "POST", headers: { ...H, ...(c ? { cookie: c } : {}) }, body: JSON.stringify({ password }) }), ctx(slug));
  let orderNo = 0;
  const order = (status: OrderStatus, extra: Record<string, unknown> = {}) =>
    db.order.create({ data: { sellerId: seller.id, orderNo: ++orderNo, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 1000, status, ...extra } });
  return { seller, grade, buyer, cookie, withdraw, order };
}

describe("구매자 탈퇴", () => {
  it("비밀번호를 확인하고 탈퇴하면 개인정보를 비식별하고 배송지·세션을 지우며, 같은 사람은 다시 가입할 수 있다", async () => {
    const s = await shop();
    await db.buyerAddress.create({
      data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "주소 1", isDefault: true },
    });
    await s.order("REFUNDED");
    await s.order("PAID", { purchaseConfirmedAt: new Date() });
    const res = await s.withdraw(PASSWORD);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.getSetCookie().find((c) => c.startsWith("lo_buyer="))).toMatch(/^lo_buyer=;/);
    const m = await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } });
    expect(m).toMatchObject({ status: "WITHDRAWN", deletedAt: expect.any(Date), name: "탈퇴한 회원", marketingConsentAt: null });
    for (const v of [s.buyer.name, s.buyer.phone, s.buyer.broadcastNickname, s.buyer.loginId]) {
      expect(JSON.stringify([m.name, m.phone, m.broadcastNickname, m.loginId])).not.toContain(v);
    }
    expect(await db.buyerAddress.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    expect(await db.buyerSession.count({ where: { buyerMemberId: s.buyer.id, revokedAt: null } })).toBe(0);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({
      after: { status: "WITHDRAWN", deletedAddresses: 1, revokedSessions: 1 },
    });
    // 주문은 회원 id로 남는다
    expect(await db.order.count({ where: { buyerMemberId: s.buyer.id } })).toBe(2);
    // 예전 세션·아이디로는 더 쓸 수 없다
    expect((await addressesRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/addresses`, { headers: { ...H, cookie: s.cookie } }), ctx(s.seller.slug))).status).toBe(401);
    const login = await loginRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ loginId: s.buyer.loginId, password: PASSWORD }) }),
      ctx(s.seller.slug),
    );
    expect(login.status).toBe(401);
    // 같은 CI·휴대폰·아이디·닉네임으로 다시 가입할 수 있다(부분 유니크 인덱스는 탈퇴 회원을 보지 않음)
    const { id: _id, createdAt: _c, deletedAt: _d, status: _st, ...again } = s.buyer;
    await expect(db.buyerMember.create({ data: again })).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("비밀번호가 틀리면 400과 문구, 아무것도 바뀌지 않고 실패를 기록한다", async () => {
    const s = await shop();
    const res = await s.withdraw("wrong-password");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "wrong_password", message: WITHDRAW_MESSAGES.wrong_password });
    expect(await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).toMatchObject({ status: "ACTIVE", deletedAt: null, name: s.buyer.name });
    expect(await db.auditLog.count({ where: { action: "buyer.withdraw_failed", actorId: s.buyer.id } })).toBe(1);
    expect((await s.withdraw(123)).status).toBe(400);
  });

  it("결제 대기·결제 완료(구매 확정 전) 주문이 있으면 409, 끝난 주문(취소·환불·구매 확정)만 있으면 탈퇴된다", async () => {
    for (const [status, extra, expected] of [
      ["PENDING_PAYMENT", {}, 409],
      ["PAID", {}, 409],
      ["PAID", { purchaseConfirmedAt: new Date() }, 200],
      ["CANCELLED", {}, 200],
      ["REFUNDED", {}, 200],
    ] as const) {
      await resetDb();
      const s = await shop();
      await s.order(status, extra);
      const res = await s.withdraw(PASSWORD);
      expect(res.status, `${status} ${JSON.stringify(extra)}`).toBe(expected);
      if (expected === 409) {
        expect(await res.json()).toEqual({ error: "orders_in_progress", message: WITHDRAW_MESSAGES.orders_in_progress });
        expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).status).toBe("ACTIVE");
      }
    }
  });

  it("로그인하지 않았거나 다른 쇼핑몰 주소로 부르면 401, 다른 출처는 403", async () => {
    const s = await shop();
    const other = await createSeller();
    expect((await s.withdraw(PASSWORD, "")).status).toBe(401);
    expect((await s.withdraw(PASSWORD, s.cookie, other.seller.slug)).status).toBe(401);
    const cross = await withdrawRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/me/withdraw`, { method: "POST", headers: { ...H, origin: "https://evil.example", cookie: s.cookie }, body: JSON.stringify({ password: PASSWORD }) }),
      ctx(s.seller.slug),
    );
    expect(cross.status).toBe(403);
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).status).toBe("ACTIVE");
  });
});
