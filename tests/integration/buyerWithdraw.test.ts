import type { OrderStatus, Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GET as addressesRoute } from "../../app/api/shop/[slug]/addresses/route";
import { POST as loginRoute } from "../../app/api/shop/[slug]/auth/login/route";
import { POST as withdrawRoute } from "../../app/api/shop/[slug]/me/withdraw/route";
import { createAddress } from "../../lib/server/buyers/addresses";
import { WITHDRAW_FAIL_LIMIT, WITHDRAW_MESSAGES, withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { writeAudit } from "../../lib/server/audit/log";
import { prisma } from "../../lib/server/db";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { getBuyerOrder, listBuyerOrders } from "../../lib/server/orders/buyer";
import { autoConfirmPurchases, unconfirmPurchase } from "../../lib/server/orders/delivery";
import { maybeRestrict } from "../../lib/server/orders/overdue";
import { getOrder, listOrders, listSellerOrders } from "../../lib/server/orders/read";
import { signupBuyer } from "../../lib/server/buyers/signup";
import { identityProvider } from "../../lib/server/identity/registry";
import { identityUsage } from "../../lib/server/identity/verification";
import { refundOrder } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, confirmIdv, createLoginBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb, startIdv } from "./helpers";

beforeEach(resetDb);
beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
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
    // 가입 때 남긴 동의 기록(마케팅 동의 버전·재가입 제한 보관 동의 스냅숏)
    await db.buyerMember.update({
      where: { id: s.buyer.id },
      data: {
        marketingConsentAt: new Date(),
        signupConsent: { termsVersion: "t", privacyVersion: "p", rejoinRetention: { version: "r", days: 30 }, marketing: { version: "m" }, agreedAt: new Date().toISOString() },
        rejoinRestrictionDaysAgreed: 30,
        rejoinRetentionAgreedAt: new Date(),
        rejoinRetentionVersion: "r",
      },
    });
    const res = await s.withdraw(PASSWORD);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.getSetCookie().find((c) => c.startsWith("lo_buyer="))).toMatch(/^lo_buyer=;/);
    const m = await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } });
    expect(m).toMatchObject({
      status: "WITHDRAWN",
      deletedAt: expect.any(Date),
      name: "탈퇴한 회원",
      marketingConsentAt: null,
      // 동의 기록도 남기지 않는다(법정 보관 주문에 이어진 회원 행에서 동의 이력을 알아볼 수 없게)
      signupConsent: null,
      rejoinRestrictionDaysAgreed: null,
      rejoinRetentionAgreedAt: null,
      rejoinRetentionVersion: null,
    });
    for (const v of [s.buyer.name, s.buyer.phone, s.buyer.broadcastNickname, s.buyer.loginId]) {
      expect(JSON.stringify([m.name, m.phone, m.broadcastNickname, m.loginId])).not.toContain(v);
    }
    // CI 해시는 비운다
    expect(m.ciHash).toBe("");
    // 남은 적립금은 소멸 원장을 남기고 0이 된다
    expect((await db.rewardBalance.findUniqueOrThrow({ where: { sellerId_buyerMemberId: { sellerId: s.seller.id, buyerMemberId: s.buyer.id } } })).balance).toBe(0);
    expect(await db.rewardLedger.findMany({ where: { buyerMemberId: s.buyer.id } })).toMatchObject([{ type: "EXPIRE", amount: -500, status: "SUCCEEDED", testMode: false, orderId: null }]);
    expect(await db.buyerAddress.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    // 세션은 폐기 표시가 아니라 행을 지운다
    expect(await db.buyerSession.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({
      after: { status: "WITHDRAWN", deletedAddresses: 1, deletedSessions: 1, anonymizedVerifications: 0, anonymizedOrders: 2, expiredPoints: 500, closedPendingRewards: 0 },
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
    const { id: _id, createdAt: _c, deletedAt: _d, status: _st, signupConsent: _sc, ...again } = s.buyer;
    await expect(db.buyerMember.create({ data: again })).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("거래 없는 회원이 탈퇴하면 회원 행의 생년월일·CI 해시를 지우고 그 회원의 본인확인 기록은 식별 항목만 비우고(requestId 무작위) 체험 한도·IP 횟수 계산 값은 남긴다. 다른 사람·다른 쇼핑몰 기록은 그대로", async () => {
    const provider = identityProvider()!;
    const { seller } = await createSeller();
    const other = await createSeller();
    const verified = async (sellerId: string, person: Record<string, string> = {}) => {
      const st = await startIdv(provider, { purpose: "BUYER_SIGNUP", sellerId, person });
      await db.identityVerification.update({ where: { id: st.verification.id }, data: { requestIp: "203.0.113.7" } });
      expect((await confirmIdv(provider, st.verification, st.ownerToken)).ok).toBe(true);
      return st;
    };
    const mine = await verified(seller.id);
    const r = await signupBuyer(db, provider, {
      sellerId: seller.id, verificationId: mine.verification.id, ownerToken: mine.ownerToken,
      loginId: "me@example.com", password: "pw-123456", broadcastNickname: "나",
    });
    if (!r.ok) throw new Error(r.reason);
    // 가입 뒤 같은 사람이 다시 한 본인확인(회원과 이어지지 않음), 다른 사람·다른 쇼핑몰의 같은 사람 기록
    const again = await verified(seller.id);
    const stranger = await verified(seller.id, { name: "김남", birth7: "9001011", phone: "01077776666" });
    const elsewhere = await verified(other.seller.id);
    const member = await db.buyerMember.findUniqueOrThrow({ where: { id: r.memberId } });
    expect(member.birthDate).not.toBeNull();
    const before = new Map((await db.identityVerification.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((v) => [v.id, v]));
    const usage = await identityUsage(db, seller.id);
    const ipCount = () => db.identityVerification.count({ where: { sellerId: seller.id, purpose: "BUYER_SIGNUP", requestIp: "203.0.113.7" } });
    const ipBefore = await ipCount();

    const now = new Date();
    expect(await withdrawBuyer(db, { sellerId: seller.id, buyerMemberId: member.id }, { password: "pw-123456", now })).toEqual({ ok: true });
    expect(await db.buyerMember.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({ birthDate: null, ciHash: "" });
    // 이 회원의 본인확인 기록(이어진 기록·같은 CI 해시 기록)은 행을 두고 식별 항목만 비운다. requestId는 무작위 값으로 바꾼다
    for (const id of [mine.verification.id, again.verification.id]) {
      const v = await db.identityVerification.findUniqueOrThrow({ where: { id } });
      const was = before.get(id)!;
      expect(v).toMatchObject({
        name: null, phone: null, requestedPhone: null, birthDate: null, ciHash: null, subjectId: null, signupConsent: null, ownerTokenHash: null,
        anonymizedAt: now, status: "VERIFIED", sellerId: seller.id, createdAt: was.createdAt, requestIp: "203.0.113.7",
      });
      expect(v.requestId).not.toBe(was.requestId);
    }
    for (const id of [stranger.verification.id, elsewhere.verification.id]) {
      expect(await db.identityVerification.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: expect.any(String), ciHash: expect.any(String), requestIp: "203.0.113.7", anonymizedAt: null });
    }
    // 체험 한도 사용량(VERIFIED 건수)과 같은 IP 기록 수는 탈퇴 뒤에도 그대로
    expect(await identityUsage(db, seller.id)).toBe(usage);
    expect(await ipCount()).toBe(ipBefore);
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.withdraw", actorId: member.id } })).toMatchObject({ after: { anonymizedVerifications: 2 } });
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
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({ after: { expiredPoints: 0, closedPendingRewards: 1 } });
    const { id: _id, createdAt: _c, deletedAt: _d, status: _st, signupConsent: _sc, ...again } = s.buyer;
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

  // 경합을 여러 번 겪어 보려고 5회 반복한다. 회차마다 따로 시험해 DB 초기화가 한 시험 시간에 쌓이지 않게 한다.
  it.each([1, 2, 3, 4, 5])("탈퇴와 환불이 동시에 와도 처리 대기 원장이 남지 않고 잔액은 0(%i회차)", async () => {
    const s = await shop();
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, balance: 300 } });
    const { refund } = await deliveredWithEarn(s);
    const [w, r] = await Promise.all([s.withdraw(PASSWORD), refund()]);
    expect(w.status).toBe(200);
    expect(r.ok).toBe(true);
    expect(await db.rewardLedger.count({ where: { buyerMemberId: s.buyer.id, status: "PENDING" } })).toBe(0);
    expect((await db.rewardBalance.findUniqueOrThrow({ where: { sellerId_buyerMemberId: { sellerId: s.seller.id, buyerMemberId: s.buyer.id } } })).balance).toBe(0);
  });

  it("[교착] 탈퇴가 회원 행을 잡은 채 멈춘 사이 환불을 시작하면 환불은 판매자 주문 잠금에서 기다리고, 둘 다 교착 없이 끝난다", async () => {
    const s = await shop();
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, balance: 300 } });
    const { refund } = await deliveredWithEarn(s);
    // 그 advisory 잠금 키(hashtext)를 기다리는 세션이 생길 때까지(최대 5초)
    const waitingOn = async (key: string) => {
      for (let i = 0; i < 200; i++) {
        const [w] = await db.$queryRaw<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_locks WHERE "locktype" = 'advisory' AND NOT "granted"
            AND "objid"::text::bigint = (hashtext(${key})::bigint & 4294967295)`;
        if (w.n > 0) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    };
    // 탈퇴가 회원 행(FOR NO KEY UPDATE)을 잡은 바로 다음 단계(배송지 잠금)에서 멈추게, 같은 배송지 잠금을 먼저 쥔다
    let release!: () => void;
    let held!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const holding = new Promise<void>((r) => (held = r));
    const blocker = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_address:${s.seller.id}:${s.buyer.id}`}))`;
        held();
        await gate;
      },
      { timeout: 20_000 },
    );
    await holding;
    const withdrawal = s.withdraw(PASSWORD);
    expect(await waitingOn(`buyer_address:${s.seller.id}:${s.buyer.id}`)).toBe(true);
    // 탈퇴는 판매자 주문 잠금 → 이 회원 주문 행 → 회원 행을 이미 쥐고 있다
    const [memberLocked] = await db.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'BuyerMember' AND l.granted AND l.mode = 'RowShareLock'`;
    expect(memberLocked.n).toBeGreaterThan(0);
    const refunding = refund();
    // 환불은 회원·주문 행이 아니라 판매자 주문 잠금(advisory)에서 기다린다
    expect(await waitingOn(`order_no:${s.seller.id}`)).toBe(true);
    release();
    const [b, w, r] = await Promise.allSettled([blocker, withdrawal, refunding]);
    expect(b.status).toBe("fulfilled");
    expect(w).toMatchObject({ status: "fulfilled", value: { status: 200 } });
    expect(r).toMatchObject({ status: "fulfilled", value: { ok: true } });
    expect(await db.rewardLedger.count({ where: { buyerMemberId: s.buyer.id, status: "PENDING" } })).toBe(0);
    expect((await db.rewardBalance.findUniqueOrThrow({ where: { sellerId_buyerMemberId: { sellerId: s.seller.id, buyerMemberId: s.buyer.id } } })).balance).toBe(0);
  });

  it("탈퇴하면 그 회원의 주문·주문대기·히트 카드 닉네임 스냅숏은 「탈퇴한 회원」으로 바꾸고 구매 제한은 지운다. 받는 사람 스냅숏과 다른 회원 기록은 그대로", async () => {
    const s = await shop();
    const other = await createLoginBuyer(s.seller.id, s.grade.id);
    const mk = async (buyerMemberId: string, nickname: string) => {
      const { order, item } = await createPaidOrderItem(s.seller.id, buyerMemberId);
      await db.order.update({ where: { id: order.id }, data: { broadcastNicknameSnapshot: nickname } });
      await db.shipment.create({ data: { sellerId: s.seller.id, orderId: order.id, courier: "CJ", trackingNumber: "123456789012", status: "DELIVERED", shippedAt: new Date(), deliveredAt: new Date() } });
      await db.orderShippingAddress.create({ data: { sellerId: s.seller.id, orderId: order.id, recipientName: "김받음", phone: "01000000000", zipCode: "00000", address1: "주소" } });
      const q = await db.queueItem.create({
        data: { sellerId: s.seller.id, orderId: order.id, orderItemId: item.id, position: 1, receivedAt: new Date(), nicknameSnapshot: nickname, productLabel: "팩", quantity: 1, status: "DONE" },
      });
      const card = await db.hitCard.create({ data: { sellerId: s.seller.id, queueItemId: q.id, buyerMemberId, nicknameSnapshot: nickname, cardName: "레어" } });
      return { order, q, card };
    };
    const mine = await mk(s.buyer.id, "내닉");
    const theirs = await mk(other.id, "남닉");
    await db.buyerPurchaseRestriction.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, reason: "UNPAID", startsAt: new Date(), endsAt: new Date(Date.now() + 86400_000) } });

    expect((await s.withdraw(PASSWORD)).status).toBe(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: mine.order.id } })).broadcastNicknameSnapshot).toBe("탈퇴한 회원");
    expect((await db.queueItem.findUniqueOrThrow({ where: { id: mine.q.id } })).nicknameSnapshot).toBe("탈퇴한 회원");
    expect((await db.hitCard.findUniqueOrThrow({ where: { id: mine.card.id } })).nicknameSnapshot).toBe("탈퇴한 회원");
    // 법정 보관 거래 기록(받는 사람 스냅숏)은 그대로
    expect((await db.orderShippingAddress.findUniqueOrThrow({ where: { orderId: mine.order.id } })).recipientName).toBe("김받음");
    expect(await db.buyerPurchaseRestriction.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    // 다른 회원 것은 그대로
    expect((await db.order.findUniqueOrThrow({ where: { id: theirs.order.id } })).broadcastNicknameSnapshot).toBe("남닉");
    expect((await db.queueItem.findUniqueOrThrow({ where: { id: theirs.q.id } })).nicknameSnapshot).toBe("남닉");
    expect((await db.hitCard.findUniqueOrThrow({ where: { id: theirs.card.id } })).nicknameSnapshot).toBe("남닉");
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({
      after: { anonymizedOrders: 1, anonymizedQueueItems: 1, anonymizedHitCards: 1, deletedRestrictions: 1 },
    });
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

  // 경우마다 따로 시험한다(한 시험에서 DB 전체 초기화를 8번 하면 CI에서 5초를 넘었다, 초기화 한 번 약 250ms)
  it.each([
    ["결제 대기", "PENDING_PAYMENT", {}, null, 200],
    ["발송 전", "PAID", {}, null, 409],
    ["배송 중", "PAID", {}, "IN_TRANSIT", 409],
    ["재고 부족 환불 대기", "PAID", { stockShortageAt: new Date() }, null, 409],
    ["배송 완료", "PAID", {}, "DELIVERED", 200],
    ["구매 확정", "PAID", { purchaseConfirmedAt: new Date() }, "DELIVERED", 200],
    ["취소", "CANCELLED", {}, null, 200],
    ["환불", "REFUNDED", {}, "IN_TRANSIT", 200],
  ] as const)(
    "결제 완료 뒤 배송 완료 전 주문(발송 전·배송 중·재고 부족 환불 대기)이 있으면 409, 결제 대기·배송 완료·구매 확정·취소·환불된 주문만 있으면 탈퇴된다: %s",
    async (_label, status, extra, shipment, expected) => {
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
        expect(await res.json()).toEqual({ error: "orders_in_progress", message: "배송 중인 주문이 끝나거나 환불되면 탈퇴할 수 있어요" });
        expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).status).toBe("ACTIVE");
      }
    },
  );

  it("탈퇴가 결제 대기 주문을 읽은 뒤 그 주문이 판매자 취소·입금 확인으로 바뀌어도 500이 아니다: 취소됐으면 건너뛰고 탈퇴, 결제됐으면 409", async () => {
    for (const [change, expected] of [
      [{ status: "CANCELLED", cancelledAt: new Date() }, { ok: true }],
      [{ status: "PAID", paidAt: new Date() }, { ok: false, reason: "orders_in_progress" }],
    ] as const) {
      await resetDb();
      const s = await shop();
      const o = await s.order("PENDING_PAYMENT");
      // 결제 대기 목록을 읽은 직후 다른 연결이 그 주문을 먼저 바꾼다(판매자 행 잠금 경로를 흉내)
      const racing = new Proxy(db, {
        get(t, p) {
          const v = Reflect.get(t, p);
          if (p !== "$transaction") return typeof v === "function" ? v.bind(t) : v;
          return (fn: (tx: Prisma.TransactionClient) => unknown, opts?: unknown) =>
            t.$transaction(
              (tx) =>
                fn(
                  new Proxy(tx, {
                    get(x, k, r) {
                      const m = Reflect.get(x, k, r);
                      if (k !== "order") return m;
                      return new Proxy(m, {
                        get: (d, f) =>
                          f !== "findMany"
                            ? Reflect.get(d, f)
                            : async (args: { where?: { status?: string } }) => {
                                const rows = await d.findMany(args as never);
                                if (args?.where?.status === "PENDING_PAYMENT") await db.order.update({ where: { id: o.id }, data: change });
                                return rows;
                              },
                      });
                    },
                  }) as Prisma.TransactionClient,
                ) as Promise<unknown>,
              opts as never,
            );
        },
      }) as typeof db;
      expect(await withdrawBuyer(racing, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD }), change.status).toEqual(expected);
      expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe(change.status);
      expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).status).toBe(expected.ok ? "WITHDRAWN" : "ACTIVE");
    }
  });

  it("입금 확인(주문 행을 바꾼 뒤 회원 행 FOR SHARE)과 탈퇴가 겹쳐도 교착 없이 입금 확인이 끝나고 탈퇴는 409", async () => {
    const s = await shop();
    const o = await s.order("PENDING_PAYMENT");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const orderLocked = new Promise<void>((r) => (locked = r));
    // 입금 확인 흉내: 주문 행을 결제로 바꿔 잠근 채, 탈퇴가 기다리기 시작한 뒤 적립 예정 기록처럼 회원 행을 FOR SHARE로 잠근다
    const payment = db.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "Order" SET "status" = 'PAID', "paidAt" = now() WHERE "id" = ${o.id}::uuid`;
        locked();
        await gate;
        await tx.$queryRaw`SELECT "id" FROM "BuyerMember" WHERE "id" = ${s.buyer.id}::uuid FOR SHARE`;
      },
      { timeout: 20_000 },
    );
    await orderLocked;
    const withdrawal = withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD });
    // 탈퇴가 잠금을 기다리기 시작할 때까지 기다린다
    for (let i = 0; i < 100; i++) {
      const [w] = await db.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE "wait_event_type" = 'Lock' AND "datname" = current_database()`;
      if (w.n > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    release();
    const [paid, withdrawn] = await Promise.allSettled([payment, withdrawal]);
    expect(paid.status).toBe("fulfilled");
    expect(withdrawn).toEqual({ status: "fulfilled", value: { ok: false, reason: "orders_in_progress" } });
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).status).toBe("ACTIVE");
  });

  it("결제 대기 주문은 탈퇴 트랜잭션 안에서 판매자 취소와 같은 경로로 자동 취소한다(주문 때 뺀 재고 되돌림·상태 이력·감사 로그). 결제 완료·배송 전 주문이 함께 있으면 아무것도 바꾸지 않고 409", async () => {
    const s = await shop();
    // 주문 때 재고를 빼는 상품(ORDER)의 결제 대기 주문
    const product = await db.product.create({ data: { sellerId: s.seller.id, name: "부스터 팩", price: 1000, status: "ON_SALE", stockDeductMode: "ORDER" } });
    const option = await db.productOption.create({ data: { sellerId: s.seller.id, productId: product.id, name: "1팩", stock: 4 } });
    const pending = await s.order("PENDING_PAYMENT");
    const now0 = new Date();
    await db.orderItem.create({ data: { sellerId: s.seller.id, orderId: pending.id, productId: product.id, optionId: option.id, productNameSnapshot: "부스터 팩", optionNameSnapshot: "1팩", unitPrice: 1000, quantity: 1, stockDeductedAt: now0 } });
    await db.stockMovement.create({ data: { sellerId: s.seller.id, optionId: option.id, delta: -1, reason: "ORDER", orderId: pending.id, actorType: "BUYER", actorId: s.buyer.id, createdAt: now0 } });

    // 결제 완료·발송 전 주문이 있으면 409이고 결제 대기 주문도 그대로
    const paid = await s.order("PAID", { paidAt: new Date() });
    const blocked = await s.withdraw(PASSWORD);
    expect(blocked.status).toBe(409);
    expect((await db.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING_PAYMENT");
    await db.order.update({ where: { id: paid.id }, data: { status: "REFUNDED", refundedAt: new Date() } });

    expect((await s.withdraw(PASSWORD)).status).toBe(200);
    expect(await db.order.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: "CANCELLED", cancelledAt: expect.any(Date), legalHoldAt: expect.any(Date) });
    expect((await db.productOption.findUniqueOrThrow({ where: { id: option.id } })).stock).toBe(5);
    expect(await db.orderStatusHistory.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { orderId: pending.id, toStatus: "CANCELLED" } })).toMatchObject({ actorType: "BUYER", actorId: s.buyer.id, reason: "member_withdrawn" });
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "order.cancel", targetId: pending.id } })).toMatchObject({ actorType: "BUYER", actorId: s.buyer.id, reason: "member_withdrawn" });
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({ after: { cancelledPendingOrders: 1 } });
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

  it("주문 생성이 탈퇴와 겹쳐도 탈퇴 회원에게 결제 대기 주문이 남지 않는다(탈퇴가 자동 취소)", async () => {
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
    // 주문이 먼저 끝나고(같은 판매자 주문 잠금), 탈퇴가 그 결제 대기 주문을 자동 취소한 뒤 진행된다
    expect(ordered.ok).toBe(true);
    expect(withdrawn).toEqual({ ok: true });
    expect(member.status).toBe("WITHDRAWN");
    expect(pending).toBe(0);
    expect(await db.order.count({ where: { buyerMemberId: s.buyer.id, status: "CANCELLED" } })).toBe(1);
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
    expect(await db.buyerSession.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({ after: { deletedSessions: 2 } });
  });
});

describe("탈퇴 회원 법정 보관 분리", () => {
  // PostgreSQL make_interval(months)와 같게 더한다(말일은 그 달 마지막 날로)
  const addMonths = (d: Date, months: number) => {
    const r = new Date(d);
    const day = r.getUTCDate();
    r.setUTCDate(1);
    r.setUTCMonth(r.getUTCMonth() + months);
    const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
    r.setUTCDate(Math.min(day, last));
    return r;
  };
  const YEAR5 = (d: Date) => new Date(Date.UTC(d.getUTCFullYear() + 5, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const ship = (sellerId: string, orderId: string, deliveredAt: Date) =>
    db.shipment.create({ data: { sellerId, orderId, courier: "CJ", trackingNumber: "123456789012", status: "DELIVERED", shippedAt: deliveredAt, deliveredAt } });

  it("탈퇴하지 않은 회원의 끝난 주문은 일반 조회에 그대로 두고, 탈퇴하면 끝난 주문(취소·환불·구매 확정)에 분리 보관 표시와 끝난 날 + 5년 만료일을 달아 판매자·구매자 일반 조회에서 뺀다. 구매 확정 전 주문은 두고, 환불·자동 구매 확정 때 분리한다", async () => {
    const s = await shop();
    const t0 = new Date("2026-09-01T00:00:00.000Z");
    const refundedAt = new Date("2026-09-05T03:00:00.000Z");
    const cancelled = await s.order("CANCELLED", { createdAt: t0, cancelledAt: new Date("2026-09-01T01:00:00.000Z") });
    const refunded = await s.order("REFUNDED", { createdAt: t0, paidAt: t0, refundedAt });
    const confirmed = await s.order("PAID", { createdAt: t0, paidAt: t0, purchaseConfirmedAt: new Date("2026-09-10T00:00:00.000Z") });
    await ship(s.seller.id, confirmed.id, new Date("2026-09-03T00:00:00.000Z"));
    const toRefund = await s.order("PAID", { paidAt: new Date() });
    await ship(s.seller.id, toRefund.id, new Date());
    const toConfirm = await s.order("PAID", { paidAt: new Date(Date.now() - 9 * 86400_000) });
    await ship(s.seller.id, toConfirm.id, new Date(Date.now() - 8 * 86400_000));
    // 다른 회원 주문은 그대로
    const other = await createLoginBuyer(s.seller.id, s.grade.id);
    const otherOrder = await db.order.create({ data: { sellerId: s.seller.id, orderNo: 99, buyerMemberId: other.id, broadcastNicknameSnapshot: "남", totalAmount: 1000, status: "CANCELLED", cancelledAt: t0 } });
    const otherToConfirm = await db.order.create({ data: { sellerId: s.seller.id, orderNo: 98, buyerMemberId: other.id, broadcastNicknameSnapshot: "남", totalAmount: 1000, status: "PAID", paidAt: new Date(Date.now() - 9 * 86400_000) } });
    await ship(s.seller.id, otherToConfirm.id, new Date(Date.now() - 8 * 86400_000));
    const owner = await createSellerUser(s.seller.id, "OWNER");
    const sctx: TenantContext = { sellerId: s.seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };

    // 탈퇴 전: 회원 서비스(주문 내역 등)를 위해 끝난 주문도 판매자·구매자 조회에 그대로 있다
    const activeList = await listSellerOrders(db, sctx, {});
    expect(activeList.ok && activeList.orders.map((o) => o.id)).toEqual(expect.arrayContaining([cancelled.id, refunded.id, confirmed.id]));
    const activeMine = await listBuyerOrders(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id });
    expect(activeMine.ok && activeMine.value.orders.map((o) => o.id)).toEqual(expect.arrayContaining([cancelled.id, refunded.id, confirmed.id]));

    const before = Date.now();
    expect((await s.withdraw(PASSWORD)).status).toBe(200);
    const rows = new Map((await db.order.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((o) => [o.id, o]));
    expect(rows.get(cancelled.id)!.legalRetainUntil).toEqual(new Date("2031-09-01T01:00:00.000Z"));
    expect(rows.get(refunded.id)!.legalRetainUntil).toEqual(YEAR5(refundedAt));
    expect(rows.get(confirmed.id)!.legalRetainUntil).toEqual(new Date("2031-09-10T00:00:00.000Z"));
    for (const id of [cancelled.id, refunded.id, confirmed.id]) expect(rows.get(id)!.legalHoldAt!.getTime()).toBeGreaterThanOrEqual(before);
    for (const id of [toRefund.id, toConfirm.id, otherOrder.id, otherToConfirm.id]) expect(rows.get(id)).toMatchObject({ legalHoldAt: null, legalRetainUntil: null });
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.withdraw", actorId: s.buyer.id } })).toMatchObject({ after: { heldOrders: 3 } });

    // 판매자 일반 조회(목록·검색·상세)와 구매자 조회에서 빠진다
    const listed = await listSellerOrders(db, sctx, {});
    if (!listed.ok) throw new Error("list");
    expect(listed.orders.map((o) => o.id).sort()).toEqual([toRefund.id, toConfirm.id, otherOrder.id, otherToConfirm.id].sort());
    const searched = await listSellerOrders(db, sctx, { q: String(refunded.orderNo) });
    expect(searched.ok).toBe(true);
    expect(searched.ok && searched.orders.map((o) => o.id)).not.toContain(refunded.id);
    expect((await listOrders(db, sctx)).map((o) => o.id)).not.toContain(refunded.id);
    await expect(getOrder(db, sctx, refunded.id)).rejects.toMatchObject({ status: 404 });
    expect((await getOrder(db, sctx, toRefund.id)).id).toBe(toRefund.id);
    expect(await getBuyerOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, refunded.id)).toBeNull();
    const mine = await listBuyerOrders(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id });
    expect(mine.ok && mine.value.orders.map((o) => o.id).sort()).toEqual([toRefund.id, toConfirm.id].sort());

    // 구매 확정 전에 탈퇴한 주문은 환불·자동 구매 확정 때 분리한다
    const r = await refundOrder(db, sctx, toRefund.id, { reason: "불량", expectedLiveVersion: (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion, fault: "SELLER" });
    expect(r.ok).toBe(true);
    const afterRefund = await db.order.findUniqueOrThrow({ where: { id: toRefund.id } });
    expect(afterRefund.legalHoldAt).not.toBeNull();
    expect(afterRefund.legalRetainUntil).toEqual(YEAR5(afterRefund.refundedAt!));
    expect((await autoConfirmPurchases(db)).done.sort()).toEqual([toConfirm.id, otherToConfirm.id].sort());
    const afterConfirm = await db.order.findUniqueOrThrow({ where: { id: toConfirm.id } });
    expect(afterConfirm.legalHoldAt).not.toBeNull();
    expect(afterConfirm.legalRetainUntil).toEqual(YEAR5(afterConfirm.purchaseConfirmedAt!));
    // 탈퇴하지 않은 회원 주문은 끝나면 보관 만료일만 계산하고 분리하지 않는다(일반 조회에 그대로)
    const otherConfirmed = await db.order.findUniqueOrThrow({ where: { id: otherToConfirm.id } });
    expect(otherConfirmed).toMatchObject({ legalHoldAt: null, legalRetainUntil: YEAR5(otherConfirmed.purchaseConfirmedAt!) });
    expect((await getOrder(db, sctx, otherToConfirm.id)).id).toBe(otherToConfirm.id);
    expect((await db.order.findUniqueOrThrow({ where: { id: otherOrder.id } })).legalHoldAt).toBeNull();

    // 분리된 구매 확정 주문을 나중에 환불하면(구매 확정을 먼저 취소) 보관 만료일을 환불 날 기준으로 다시 계산한다(분리 표시는 그대로)
    const heldAt = rows.get(confirmed.id)!.legalHoldAt;
    expect(await unconfirmPurchase(db, sctx, confirmed.id, { reason: "불량" })).toMatchObject({ ok: true });
    const late = await refundOrder(db, sctx, confirmed.id, { reason: "불량", expectedLiveVersion: (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion, fault: "SELLER" });
    expect(late.ok).toBe(true);
    const lateRefunded = await db.order.findUniqueOrThrow({ where: { id: confirmed.id } });
    expect(lateRefunded.legalHoldAt).toEqual(heldAt);
    expect(lateRefunded.legalRetainUntil).toEqual(YEAR5(lateRefunded.refundedAt!));
  });

  it("탈퇴한 회원에게는 구매 제한을 새로 만들지 않는다", async () => {
    const s = await shop();
    expect((await s.withdraw(PASSWORD)).status).toBe(200);
    // 탈퇴 뒤에 기준(미입금 자동 취소 3회)을 채운 경우
    for (let i = 0; i < 3; i++) {
      const at = new Date(Date.now() - (3 - i) * 60_000);
      await s.order("CANCELLED", { cancelledAt: at, autoCancelledAt: at });
    }
    const r = await db.$transaction((tx) => maybeRestrict(tx, s.seller.id, s.buyer.id, new Date()));
    expect(r).toBeNull();
    expect(await db.buyerPurchaseRestriction.count({ where: { buyerMemberId: s.buyer.id } })).toBe(0);
    // 탈퇴하지 않은 회원은 그대로 제한된다
    const t = await shop();
    for (let i = 0; i < 3; i++) {
      const at = new Date(Date.now() - (3 - i) * 60_000);
      await t.order("CANCELLED", { cancelledAt: at, autoCancelledAt: at });
    }
    expect(await db.$transaction((tx) => maybeRestrict(tx, t.seller.id, t.buyer.id, new Date()))).not.toBeNull();
  });

  it("회원이 행위자·대상인 감사 로그는 기록할 때 보관 기한(거래 관련 기록 시각 + 5년, 거래 무관 기록 시각 + 3개월)을 달고(탈퇴와 상관없이), 탈퇴하면 거래 관련만 분리 보관한다. 다른 회원·다른 쇼핑몰 기록은 그대로", async () => {
    const s = await shop();
    const at = new Date("2026-08-01T00:00:00.000Z");
    const log = (action: string, extra: Record<string, unknown> = {}) =>
      db.auditLog.create({ data: { actorType: "BUYER", actorId: s.buyer.id, sellerId: s.seller.id, action, createdAt: at, ...extra } });
    const orderCreate = await log("order.create", { targetType: "Order", targetId: crypto.randomUUID() });
    const login = await log("auth.buyer.login");
    const loginFailed = await log("auth.buyer.login_failed", { reason: "wrong_password" });
    const signup = await log("buyer.signup");
    const address = await log("buyer_address.update", { targetType: "BuyerAddress", targetId: crypto.randomUUID() });
    const restriction = await db.auditLog.create({
      data: { actorType: "SYSTEM", sellerId: s.seller.id, action: "buyer.purchase_restriction.create", targetType: "BuyerMember", targetId: s.buyer.id, createdAt: at },
    });
    const unknown = await log("buyer.something_new");
    const other = await db.auditLog.create({ data: { actorType: "BUYER", actorId: crypto.randomUUID(), sellerId: s.seller.id, action: "order.create", createdAt: at } });
    const { seller: otherShop } = await createSeller();
    const otherShopRow = await db.auditLog.create({ data: { actorType: "BUYER", actorId: s.buyer.id, sellerId: otherShop.id, action: "auth.buyer.login", createdAt: at } });

    const now = new Date("2026-10-03T05:00:00.000Z");
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { password: PASSWORD, now })).toEqual({ ok: true });
    const get = (id: string) => db.auditLog.findUniqueOrThrow({ where: { id } });
    const fiveYears = new Date("2031-08-01T00:00:00.000Z");
    const threeMonths = new Date("2026-11-01T00:00:00.000Z");
    expect(await get(orderCreate.id)).toMatchObject({ legalHoldAt: now, retainUntil: fiveYears });
    // 분류가 없는 행동은 더 긴 거래 관련 기준
    expect(await get(unknown.id)).toMatchObject({ legalHoldAt: now, retainUntil: fiveYears });
    for (const r of [login, loginFailed, signup, address, restriction]) expect(await get(r.id), r.action).toMatchObject({ legalHoldAt: null, retainUntil: threeMonths });
    const withdrawRow = await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.withdraw", actorId: s.buyer.id } });
    expect(withdrawRow.legalHoldAt).toBeNull();
    expect(withdrawRow.retainUntil).toEqual(addMonths(withdrawRow.createdAt, 3));
    for (const r of [other, otherShopRow]) expect(await get(r.id)).toMatchObject({ legalHoldAt: null, retainUntil: null });
  });

  it("탈퇴하지 않은 회원도 감사 로그를 남길 때 행동 종류별 보관 기한이 기록 시각 기준으로 붙고, 회원과 무관한 행은 붙지 않는다", async () => {
    const s = await shop();
    await writeAudit(db, { actorType: "BUYER", actorId: s.buyer.id, sellerId: s.seller.id, action: "auth.buyer.login" });
    await writeAudit(db, { actorType: "BUYER", actorId: s.buyer.id, sellerId: s.seller.id, action: "order.create", targetType: "Order", targetId: crypto.randomUUID() });
    await writeAudit(db, { actorType: "SYSTEM", sellerId: s.seller.id, action: "buyer.purchase_restriction.lift", targetType: "BuyerMember", targetId: s.buyer.id });
    await writeAudit(db, { actorType: "SELLER_USER", actorId: crypto.randomUUID(), sellerId: s.seller.id, action: "product.create", targetType: "Product", targetId: crypto.randomUUID() });
    const rows = new Map((await db.auditLog.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: s.seller.id } })).map((r) => [r.action, r]));
    const login = rows.get("auth.buyer.login")!;
    expect(login.retainUntil).toEqual(addMonths(login.createdAt, 3));
    const order = rows.get("order.create")!;
    expect(order.retainUntil).toEqual(addMonths(order.createdAt, 60));
    const lift = rows.get("buyer.purchase_restriction.lift")!;
    expect(lift.retainUntil).toEqual(addMonths(lift.createdAt, 3));
    expect(rows.get("product.create")!.retainUntil).toBeNull();
    for (const r of rows.values()) expect(r.legalHoldAt).toBeNull();
  });
});
