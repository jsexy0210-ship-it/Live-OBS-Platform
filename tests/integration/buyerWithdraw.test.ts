import type { OrderStatus } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as addressesRoute } from "../../app/api/shop/[slug]/addresses/route";
import { POST as loginRoute } from "../../app/api/shop/[slug]/auth/login/route";
import { POST as withdrawRoute } from "../../app/api/shop/[slug]/me/withdraw/route";
import { WITHDRAW_MESSAGES } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { loginSeller } from "../../lib/server/auth/login";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

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
    const done = await s.order("PAID", { purchaseConfirmedAt: new Date() });
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: done.id, courier: "CJ", trackingNumber: "123456789012", status: "DELIVERED", shippedAt: new Date(), deliveredAt: new Date() } });
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, balance: 500 } });
    const res = await s.withdraw(PASSWORD);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.getSetCookie().find((c) => c.startsWith("lo_buyer="))).toMatch(/^lo_buyer=;/);
    const m = await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } });
    expect(m).toMatchObject({ status: "WITHDRAWN", deletedAt: expect.any(Date), name: "탈퇴한 회원", marketingConsentAt: null });
    for (const v of [s.buyer.name, s.buyer.phone, s.buyer.broadcastNickname, s.buyer.loginId, s.buyer.ciHash]) {
      expect(JSON.stringify([m.name, m.phone, m.broadcastNickname, m.loginId, m.ciHash])).not.toContain(v);
    }
    // 남은 적립금은 소멸(잔액 0, 원장에 음수 조정)
    expect((await db.rewardBalance.findUniqueOrThrow({ where: { sellerId_buyerMemberId: { sellerId: s.seller.id, buyerMemberId: s.buyer.id } } })).balance).toBe(0);
    expect(await db.rewardLedger.findMany({ where: { buyerMemberId: s.buyer.id } })).toMatchObject([{ type: "ADJUST", amount: -500, status: "SUCCEEDED" }]);
    expect(await db.buyerAddress.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    expect(await db.buyerSession.count({ where: { buyerMemberId: s.buyer.id, revokedAt: null } })).toBe(0);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({
      after: { status: "WITHDRAWN", deletedAddresses: 1, revokedSessions: 1, expiredReward: 500 },
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

  it("비밀번호가 틀리면 구매자 로그인 실패와 같은 401과 문구, 아무것도 바뀌지 않고 실패를 기록한다", async () => {
    const s = await shop();
    const res = await s.withdraw("wrong-password");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "invalid_credentials", message: "아이디나 비밀번호가 맞지 않아요" });
    expect(WITHDRAW_MESSAGES.invalid_credentials).toBe("아이디나 비밀번호가 맞지 않아요");
    expect(await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).toMatchObject({ status: "ACTIVE", deletedAt: null, name: s.buyer.name });
    expect(await db.auditLog.count({ where: { action: "buyer.withdraw_failed", actorId: s.buyer.id } })).toBe(1);
    expect((await s.withdraw(123)).status).toBe(401);
  });

  it("진행 중인 주문(결제 대기·발송 전·배송 중)이 있으면 409, 배송 완료·구매 확정·취소·환불된 주문만 있으면 탈퇴된다", async () => {
    for (const [status, extra, shipment, expected] of [
      ["PENDING_PAYMENT", {}, null, 409],
      ["PAID", {}, null, 409],
      ["PAID", {}, "IN_TRANSIT", 409],
      ["PAID", { stockShortageAt: new Date() }, null, 409],
      ["PAID", {}, "DELIVERED", 200],
      ["PAID", { purchaseConfirmedAt: new Date() }, "DELIVERED", 200],
      ["CANCELLED", {}, null, 200],
      ["REFUNDED", {}, "IN_TRANSIT", 200],
    ] as const) {
      await resetDb();
      const s = await shop();
      const o = await s.order(status, extra);
      if (shipment) {
        await db.shipment.create({
          data: { sellerId: s.seller.id, orderId: o.id, courier: "CJ", trackingNumber: "123456789012", status: shipment, shippedAt: new Date(), deliveredAt: shipment === "DELIVERED" ? new Date() : null },
        });
      }
      const res = await s.withdraw(PASSWORD);
      expect(res.status, `${status} ${JSON.stringify(extra)} ${shipment}`).toBe(expected);
      if (expected === 409) {
        expect(await res.json()).toEqual({ error: "orders_in_progress", message: "진행 중인 주문이 끝나면 탈퇴할 수 있어요" });
        expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).status).toBe("ACTIVE");
      }
    }
  });

  it("로그인하지 않았거나, 다른 쇼핑몰 세션·판매자 세션이면 401, 다른 출처는 403", async () => {
    const s = await shop();
    const other = await shop();
    expect((await s.withdraw(PASSWORD, "")).status).toBe(401);
    // 다른 쇼핑몰 구매자 세션으로 이 쇼핑몰 주소를 부름
    expect((await s.withdraw(PASSWORD, other.cookie)).status).toBe(401);
    // 이 쇼핑몰 세션으로 다른 쇼핑몰 주소를 부름
    expect((await s.withdraw(PASSWORD, s.cookie, other.seller.slug)).status).toBe(401);
    // 판매자 세션(구매자 세션 없음)
    const owner = await createSellerUser(s.seller.id, "OWNER");
    const sellerLogin = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!sellerLogin.ok) throw new Error(sellerLogin.reason);
    expect((await s.withdraw(PASSWORD, `lo_seller=${sellerLogin.token}`)).status).toBe(401);
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: other.buyer.id } })).status).toBe("ACTIVE");
    const cross = await withdrawRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/me/withdraw`, { method: "POST", headers: { ...H, origin: "https://evil.example", cookie: s.cookie }, body: JSON.stringify({ password: PASSWORD }) }),
      ctx(s.seller.slug),
    );
    expect(cross.status).toBe(403);
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).status).toBe("ACTIVE");
  });
});
