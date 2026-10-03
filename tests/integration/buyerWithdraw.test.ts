import type { OrderStatus, PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as addressesRoute } from "../../app/api/shop/[slug]/addresses/route";
import { POST as loginRoute } from "../../app/api/shop/[slug]/auth/login/route";
import { POST as withdrawRoute } from "../../app/api/shop/[slug]/me/withdraw/route";
import { createAddress } from "../../lib/server/buyers/addresses";
import { WITHDRAW_FAIL_LIMIT, WITHDRAW_MESSAGES, withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { prisma } from "../../lib/server/db";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { refundOrder } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const ADDR = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };
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
    for (const v of [s.buyer.name, s.buyer.phone, s.buyer.broadcastNickname, s.buyer.loginId]) {
      expect(JSON.stringify([m.name, m.phone, m.broadcastNickname, m.loginId])).not.toContain(v);
    }
    // CI 해시는 비운다
    expect(m.ciHash).toBe("");
    // 남은 적립금은 소멸 원장을 남기고 0이 된다
    expect((await db.rewardBalance.findUniqueOrThrow({ where: { sellerId_buyerMemberId: { sellerId: s.seller.id, buyerMemberId: s.buyer.id } } })).balance).toBe(0);
    expect(await db.rewardLedger.findMany({ where: { buyerMemberId: s.buyer.id } })).toMatchObject([{ type: "EXPIRE", amount: -500, status: "SUCCEEDED", testMode: false, orderId: null }]);
    expect(await db.buyerAddress.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    expect(await db.buyerSession.count({ where: { buyerMemberId: s.buyer.id, revokedAt: null } })).toBe(0);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({
      after: { status: "WITHDRAWN", deletedAddresses: 1, revokedSessions: 1, expiredPoints: 500, closedPendingRewards: 0 },
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

  it("탈퇴하면 처리 전 적립 원장(지급·회수 대기)은 실패(member_withdrawn)로 닫히고, 잔액이 없으면 소멸 원장을 남기지 않으며, 같은 사람이 다시 가입해도 적립금은 0", async () => {
    const s = await shop();
    const done = await s.order("PAID", { purchaseConfirmedAt: new Date() });
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: done.id, courier: "CJ", trackingNumber: "123456789012", status: "DELIVERED", shippedAt: new Date(), deliveredAt: new Date() } });
    const pending = await db.rewardLedger.create({
      data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: done.id, type: "EARN", amount: 300, status: "PENDING", testMode: false, idempotencyKey: `earn:${done.id}` },
    });
    expect((await s.withdraw(PASSWORD)).status).toBe(200);
    expect(await db.rewardLedger.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: "FAILED", failureReason: "member_withdrawn", processedAt: expect.any(Date) });
    expect(await db.rewardLedger.count({ where: { buyerMemberId: s.buyer.id, type: "EXPIRE" } })).toBe(0);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({ after: { expiredPoints: 0, closedPendingRewards: 1 } });
    const { id: _id, createdAt: _c, deletedAt: _d, status: _st, ...again } = s.buyer;
    const back = await db.buyerMember.create({ data: again });
    expect(await db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: { sellerId: s.seller.id, buyerMemberId: back.id } } })).toBeNull();
    expect(await db.rewardLedger.count({ where: { buyerMemberId: back.id } })).toBe(0);
  });

  // 배송 완료한 결제 완료 주문 + 지급 대기 적립(EARN 300)
  async function deliveredWithEarn(s: Awaited<ReturnType<typeof shop>>) {
    const o = await s.order("PAID", { purchaseConfirmedAt: null });
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: o.id, courier: "CJ", trackingNumber: "123456789012", status: "DELIVERED", shippedAt: new Date(), deliveredAt: new Date() } });
    await db.rewardLedger.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: o.id, type: "EARN", amount: 300, status: "PENDING", testMode: false, idempotencyKey: `earn:${o.id}` } });
    const owner = await createSellerUser(s.seller.id, "OWNER");
    const ctx: TenantContext = { sellerId: s.seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
    const refund = async () =>
      refundOrder(db, ctx, o.id, { reason: "불량", expectedLiveVersion: (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion, fault: "SELLER" });
    return { order: o, refund };
  }

  it("탈퇴한 회원의 주문을 나중에 환불해도 회수 원장은 처리 대기가 아니라 실패(member_withdrawn)로 남는다", async () => {
    const s = await shop();
    const { order, refund } = await deliveredWithEarn(s);
    expect((await s.withdraw(PASSWORD)).status).toBe(200);
    expect(await refund()).toMatchObject({ ok: true, value: { rewardRevoke: "revoked" } });
    expect(await db.rewardLedger.findUniqueOrThrow({ where: { sellerId_idempotencyKey: { sellerId: s.seller.id, idempotencyKey: `revoke:${order.id}` } } })).toMatchObject({
      status: "FAILED",
      failureReason: "member_withdrawn",
    });
    expect(await db.rewardLedger.count({ where: { buyerMemberId: s.buyer.id, status: "PENDING" } })).toBe(0);
  });

  it("탈퇴와 환불이 동시에 와도 처리 대기 원장이 남지 않고 잔액은 0", async () => {
    for (let i = 0; i < 5; i++) {
      await resetDb();
      const s = await shop();
      await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, balance: 300 } });
      const { refund } = await deliveredWithEarn(s);
      const [w, r] = await Promise.all([s.withdraw(PASSWORD), refund()]);
      expect(w.status).toBe(200);
      expect(r.ok).toBe(true);
      expect(await db.rewardLedger.count({ where: { buyerMemberId: s.buyer.id, status: "PENDING" } })).toBe(0);
      expect((await db.rewardBalance.findUniqueOrThrow({ where: { sellerId_buyerMemberId: { sellerId: s.seller.id, buyerMemberId: s.buyer.id } } })).balance).toBe(0);
    }
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

  it("같은 회원이 15분 안에 비밀번호를 5번 틀리면 429(맞는 비밀번호여도), 동시에 보내도 실패 기록은 5번을 넘지 않는다", async () => {
    const s = await shop();
    const results = await Promise.all(Array.from({ length: 9 }, () => s.withdraw("wrong-password")));
    const codes = results.map((r) => r.status).sort();
    expect(codes.filter((c) => c === 401)).toHaveLength(WITHDRAW_FAIL_LIMIT);
    expect(codes.filter((c) => c === 429)).toHaveLength(9 - WITHDRAW_FAIL_LIMIT);
    expect(await db.auditLog.count({ where: { action: "buyer.withdraw_failed", actorId: s.buyer.id } })).toBe(WITHDRAW_FAIL_LIMIT);
    const blocked = await s.withdraw(PASSWORD);
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "too_many_attempts", message: "비밀번호를 여러 번 틀렸어요. 잠시 뒤 다시 해 주세요" });
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).status).toBe("ACTIVE");
    // 15분이 지난 실패는 세지 않는다
    await db.auditLog.updateMany({ where: { action: "buyer.withdraw_failed", actorId: s.buyer.id }, data: { createdAt: new Date(Date.now() - 16 * 60_000) } });
    expect((await s.withdraw(PASSWORD)).status).toBe(200);
  });

  it("진행 중인 주문(결제 대기·발송 전·배송 중·재고 부족 환불 대기)이 있으면 409, 배송 완료·구매 확정·취소·환불된 주문만 있으면 탈퇴된다", async () => {
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

// 경합 재현: model.method를 부르기 직전에(트랜잭션 안팎 모두) gate가 풀릴 때까지 멈춘다.
function pauseBefore(target: PrismaClient, model: string, method: string, gate: Promise<unknown>): PrismaClient {
  const wrapModel = (v: object) =>
    new Proxy(v, {
      get(d, m, dr) {
        const f = Reflect.get(d, m, dr);
        return m === method ? async (...a: unknown[]) => (await gate, f.apply(d, a)) : f;
      },
    });
  const wrapTx = (tx: object) => new Proxy(tx, { get: (t, p, r) => (p === model ? wrapModel(Reflect.get(t, p, r)) : Reflect.get(t, p, r)) });
  return new Proxy(target, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (p === model) return wrapModel(v);
      if (p === "$transaction") return (fn: (tx: object) => unknown, o?: unknown) => t.$transaction((tx) => fn(wrapTx(tx)) as Promise<unknown>, o as never);
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
}

// 탈퇴가 끝나거나(잠금에 막히면) 0.5초가 지나면 풀린다
const settleOrTimeout = (p: Promise<unknown>) => Promise.race([p.catch(() => null), new Promise((r) => setTimeout(r, 500))]);

describe("탈퇴와 동시 요청", () => {
  it("배송지 저장이 탈퇴와 겹쳐도 탈퇴 회원에게 배송지가 남지 않는다", async () => {
    const s = await shop();
    const scope = { sellerId: s.seller.id, buyerMemberId: s.buyer.id };
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    // 배송지 저장이 잠금·확인을 마치고 저장 직전에 멈춘 사이 탈퇴한다
    const saving = createAddress(pauseBefore(db, "buyerAddress", "findFirst", gate), scope, ADDR);
    await new Promise((r) => setTimeout(r, 100));
    const withdrawing = withdrawBuyer(db, scope, { password: PASSWORD });
    settleOrTimeout(withdrawing).then(release);
    const [saved, withdrawn] = await Promise.all([saving, withdrawing]);
    expect(withdrawn).toEqual({ ok: true });
    expect(await db.buyerAddress.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    // 탈퇴한 뒤(예전 세션으로 범위를 이미 얻은 요청)에는 배송지를 저장·수정·삭제할 수 없다
    expect(saved.ok).toBe(true);
    expect(await createAddress(db, scope, ADDR)).toEqual({ ok: false, reason: "address_not_found" });
    expect(await db.buyerAddress.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
  });

  it("주문 생성이 탈퇴와 겹쳐도 탈퇴 회원에게 결제 대기 주문이 생기지 않는다", async () => {
    const s = await shop();
    const product = await db.product.create({ data: { sellerId: s.seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: s.seller.id, productId: product.id, name: "1박스", stock: 10 } });
    const scope = { sellerId: s.seller.id, buyerMemberId: s.buyer.id };
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    // 주문이 회원을 확인하고 주문 행을 쓰기 직전에 멈춘 사이 탈퇴한다
    const ordering = createOrder(pauseBefore(db, "order", "create", gate), {
      ...scope,
      items: [{ optionId: option.id, quantity: 1 }],
      consent: { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version },
      shippingAddress: ADDR,
    });
    await new Promise((r) => setTimeout(r, 100));
    const withdrawing = withdrawBuyer(db, scope, { password: PASSWORD });
    settleOrTimeout(withdrawing).then(release);
    const [ordered, withdrawn] = await Promise.all([ordering, withdrawing]);
    const member = await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } });
    const pending = await db.order.count({ where: { buyerMemberId: s.buyer.id, status: "PENDING_PAYMENT" } });
    // 주문이 먼저 끝나므로 탈퇴는 진행 중 주문으로 막힌다
    expect(ordered.ok).toBe(true);
    expect(withdrawn).toEqual({ ok: false, reason: "orders_in_progress" });
    expect(member.status).toBe("ACTIVE");
    expect(pending).toBe(1);
  });
  it("로그인이 탈퇴와 겹쳐도 탈퇴 회원에게 살아 있는 세션이 남지 않는다", async () => {
    const s = await shop();
    const scope = { sellerId: s.seller.id, buyerMemberId: s.buyer.id };
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    // 로그인이 비밀번호를 확인하고 세션을 만들기 직전에 멈춘 사이 탈퇴한다
    const logging = loginBuyer(pauseBefore(db, "buyerSession", "create", gate), { sellerId: s.seller.id, loginId: s.buyer.loginId!, password: PASSWORD }, {});
    await new Promise((r) => setTimeout(r, 300));
    const withdrawing = withdrawBuyer(db, scope, { password: PASSWORD });
    settleOrTimeout(withdrawing).then(release);
    const [logged, withdrawn] = await Promise.all([logging, withdrawing]);
    expect(withdrawn).toEqual({ ok: true });
    // 로그인이 먼저 세션을 만들었으면 탈퇴가 그 세션까지 폐기한다
    expect(logged.ok).toBe(true);
    expect(await db.buyerSession.count({ where: { buyerMemberId: s.buyer.id, revokedAt: null } })).toBe(0);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({ after: { revokedSessions: 2 } });
  });
});
