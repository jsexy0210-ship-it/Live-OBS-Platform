import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { FakePaymentGateway } from "../../lib/server/payments/gateway";
import {
  CANCEL_RETRY_AFTER_MS,
  confirmAuthResult,
  handleWebhook,
  processPaymentCancel,
  processPendingPayments,
  reconcilePayment,
  startPayment,
} from "../../lib/server/payments/service";
import { cancelPendingOrder, refundOrder } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { prisma } from "../../lib/server/db";
import { POST as startRoute } from "../../app/api/shop/[slug]/payments/route";
import { POST as returnRoute } from "../../app/api/payments/nicepay/return/route";
import { POST as webhookRoute } from "../../app/api/payments/nicepay/webhook/route";
import { loginBuyer } from "../../lib/server/auth/login";
import { PAYMENT_MESSAGES } from "../../lib/server/payments/messages";
import { setPaymentGatewayForTest } from "../../lib/server/payments/registry";
import { PASSWORD, createBuyer, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  setPaymentGatewayForTest(undefined);
  await db.$disconnect();
  await prisma.$disconnect();
});

// 품목 5,000원 × 2 + 배송비 3,000원 = 13,000원
async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createBuyer(seller.id, grade.id);
  let orderNo = 0;
  async function order(opts: { total?: number; buyerMemberId?: string; stock?: number } = {}) {
    const o = await db.order.create({
      data: { sellerId: seller.id, orderNo: ++orderNo, buyerMemberId: opts.buyerMemberId ?? buyer.id, broadcastNicknameSnapshot: "닉", shippingFee: 3000, totalAmount: opts.total ?? 13000 },
    });
    const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock: opts.stock ?? 10 } });
    await db.orderItem.create({
      data: { sellerId: seller.id, orderId: o.id, productId: product.id, optionId: option.id, productNameSnapshot: "부스터 팩", optionNameSnapshot: "1팩", unitPrice: 5000, quantity: 2 },
    });
    return o;
  }
  const gw = new FakePaymentGateway();
  const start = async (orderId: string, buyerMemberId = buyer.id) => {
    const r = await startPayment(db, gw, { sellerId: seller.id, buyerMemberId, orderId });
    if (!r.ok) throw new Error(r.reason);
    return r;
  };
  return { seller, grade, ctx, buyer, order, gw, start };
}

const orderOf = (id: string) => db.order.findUniqueOrThrow({ where: { id } });
const paymentOf = (id: string) => db.payment.findUniqueOrThrow({ where: { id } });
const lv = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;

describe("결제 시작: 금액은 서버가 다시 계산", () => {
  it("품목·배송비로 계산한 금액과 결제 창 값을 준다", async () => {
    const s = await setup();
    const o = await s.order();
    const r = await s.start(o.id);
    expect(r).toMatchObject({ clientId: "fake-client", method: "card", amount: 13000, goodsName: "부스터 팩" });
    expect(r.orderId).toBe(r.paymentId);
    expect(await paymentOf(r.paymentId)).toMatchObject({ status: "READY", amount: 13000, orderId: o.id, method: "CARD", provider: "fake" });
  });

  it("저장된 합계와 다시 계산한 금액이 다르면 결제를 시작하지 않는다", async () => {
    const s = await setup();
    const o = await s.order({ total: 100 });
    expect(await startPayment(db, s.gw, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: o.id })).toEqual({ ok: false, reason: "amount_mismatch" });
    expect(await db.payment.count()).toBe(0);
  });

  it("다른 구매자·다른 쇼핑몰 주문은 404, 결제 대기가 아니거나 기한이 지난 주문은 거절", async () => {
    const s = await setup();
    const other = await createBuyer(s.seller.id, s.grade.id);
    const o = await s.order();
    expect(await startPayment(db, s.gw, { sellerId: s.seller.id, buyerMemberId: other.id, orderId: o.id })).toEqual({ ok: false, reason: "not_found" });
    const t = await setup();
    expect(await startPayment(db, s.gw, { sellerId: t.seller.id, buyerMemberId: s.buyer.id, orderId: o.id })).toEqual({ ok: false, reason: "not_found" });
    await db.order.update({ where: { id: o.id }, data: { paymentDueAt: new Date(Date.now() - 1000) } });
    expect(await startPayment(db, s.gw, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: o.id })).toEqual({ ok: false, reason: "order_not_payable" });
  });

  it("잠긴 쇼핑몰은 결제를 시작하지 않는다", async () => {
    const s = await setup();
    const o = await s.order();
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect(await startPayment(db, s.gw, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: o.id })).toEqual({ ok: false, reason: "shop_unavailable" });
  });
});

describe("승인: 서명·금액 검증, 두 번 승인 금지", () => {
  it("인증 결과가 맞으면 승인하고 주문을 결제 완료로 바꾼다(주문대기 생성, PG 거래 번호 기록)", async () => {
    const s = await setup();
    const o = await s.order();
    const p = await s.start(o.id);
    const r = await confirmAuthResult(db, s.gw, s.gw.authorize(p.orderId, p.amount));
    expect(r).toEqual({ ok: true, outcome: "paid", sellerId: s.seller.id, orderId: o.id });
    expect(await orderOf(o.id)).toMatchObject({ status: "PAID", paymentMethod: "CARD", pgProvider: "fake", pgTxId: `fake-tid-${p.paymentId}` });
    expect(await paymentOf(p.paymentId)).toMatchObject({ status: "PAID", pgTid: `fake-tid-${p.paymentId}` });
    expect(await db.queueItem.count({ where: { orderId: o.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "payment.approved", targetId: o.id } })).toBe(1);
  });

  it("같은 인증 결과가 다시 와도(새로 고침·재전송) PG 승인은 한 번", async () => {
    const s = await setup();
    const o = await s.order();
    const p = await s.start(o.id);
    const auth = s.gw.authorize(p.orderId, p.amount);
    const rs = await Promise.all([confirmAuthResult(db, s.gw, auth), confirmAuthResult(db, s.gw, auth), confirmAuthResult(db, s.gw, auth)]);
    expect(s.gw.approveCalls).toBe(1);
    expect(rs.filter((r) => r.ok && r.outcome === "paid").length).toBeGreaterThanOrEqual(1);
    expect(await db.queueItem.count({ where: { orderId: o.id } })).toBe(1);
    expect((await confirmAuthResult(db, s.gw, auth))).toMatchObject({ ok: true, outcome: "paid" });
    expect(s.gw.approveCalls).toBe(1);
  });

  it("같은 주문의 결제 창을 두 개 열어 둘 다 인증해도 하나만 승인한다", async () => {
    const s = await setup();
    const o = await s.order();
    const a = await s.start(o.id);
    const b = await s.start(o.id);
    const [ra, rb] = await Promise.all([confirmAuthResult(db, s.gw, s.gw.authorize(a.orderId, 13000)), confirmAuthResult(db, s.gw, s.gw.authorize(b.orderId, 13000))]);
    expect([ra, rb].filter((r) => r.ok && r.outcome === "paid")).toHaveLength(1);
    expect(s.gw.approveCalls).toBe(1);
    expect(await db.payment.count({ where: { orderId: o.id, status: "PAID" } })).toBe(1);
    expect(await db.payment.count({ where: { orderId: o.id, status: "FAILED", failureCode: "duplicate_payment" } })).toBe(1);
    // 결제가 끝난 주문은 새 결제를 시작하지 않는다
    expect(await startPayment(db, s.gw, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: o.id })).toEqual({ ok: false, reason: "already_paid" });
  });

  it("서명이 틀리면 아무것도 바꾸지 않고, 금액을 바꾼 인증 결과는 승인하지 않는다", async () => {
    const s = await setup();
    const o = await s.order();
    const p = await s.start(o.id);
    const auth = s.gw.authorize(p.orderId, p.amount);
    expect(await confirmAuthResult(db, s.gw, { ...auth, signature: "forged" })).toEqual({ ok: false, reason: "invalid_signature" });
    expect((await paymentOf(p.paymentId)).status).toBe("READY");
    // 금액을 낮춰 서명까지 다시 만든 경우(클라이언트 키는 공개값): 서버 금액과 달라 승인하지 않는다
    const cheap = s.gw.authorize(p.orderId, 100, "tid-cheap");
    expect(await confirmAuthResult(db, s.gw, cheap)).toMatchObject({ ok: true, outcome: "failed" });
    expect(s.gw.approveCalls).toBe(0);
    expect(await paymentOf(p.paymentId)).toMatchObject({ status: "FAILED", failureCode: "amount_mismatch" });
    expect((await orderOf(o.id)).status).toBe("PENDING_PAYMENT");
  });

  it("인증 실패·PG 거절이면 결제 실패, 주문은 결제 대기 그대로", async () => {
    const s = await setup();
    const o = await s.order();
    const p1 = await s.start(o.id);
    expect(await confirmAuthResult(db, s.gw, { ...s.gw.authorize(p1.orderId, 13000), authResultCode: "9999" })).toMatchObject({ ok: true, outcome: "failed" });
    expect(await paymentOf(p1.paymentId)).toMatchObject({ status: "FAILED", failureCode: "auth_9999" });
    const p2 = await s.start(o.id);
    s.gw.failNext = "reject";
    expect(await confirmAuthResult(db, s.gw, s.gw.authorize(p2.orderId, 13000))).toMatchObject({ ok: true, outcome: "failed" });
    expect(await paymentOf(p2.paymentId)).toMatchObject({ status: "FAILED", failureCode: "card_declined" });
    expect((await orderOf(o.id)).status).toBe("PENDING_PAYMENT");
    // 실패한 뒤 다시 결제할 수 있다
    const p3 = await s.start(o.id);
    expect(await confirmAuthResult(db, s.gw, s.gw.authorize(p3.orderId, 13000))).toMatchObject({ ok: true, outcome: "paid" });
  });

  it("승인 응답을 못 받으면 망 취소하고 실패로 둔다(PG에서도 돈이 남지 않음)", async () => {
    const s = await setup();
    const o = await s.order();
    const p = await s.start(o.id);
    s.gw.failNext = "timeout_after";
    expect(await confirmAuthResult(db, s.gw, s.gw.authorize(p.orderId, 13000))).toMatchObject({ ok: true, outcome: "failed" });
    expect(await paymentOf(p.paymentId)).toMatchObject({ status: "FAILED", failureCode: "approve_timeout" });
    expect(s.gw.payments.get(`fake-tid-${p.paymentId}`)?.status).toBe("cancelled");
    expect((await orderOf(o.id)).status).toBe("PENDING_PAYMENT");
  });

  it("망 취소 결과도 모르면 승인 중으로 두고, 조회로 확정한다", async () => {
    const s = await setup();
    const o = await s.order();
    const p = await s.start(o.id);
    s.gw.failNext = "timeout_after";
    s.gw.netCancel = async () => ({ kind: "unknown", error: "timeout" });
    expect(await confirmAuthResult(db, s.gw, s.gw.authorize(p.orderId, 13000))).toMatchObject({ ok: true, outcome: "pending" });
    expect((await paymentOf(p.paymentId)).status).toBe("APPROVING");
    expect(await reconcilePayment(db, s.gw, p.paymentId)).toBe("paid");
    expect((await orderOf(o.id)).status).toBe("PAID");
    expect(await reconcilePayment(db, s.gw, p.paymentId)).toBe("paid");
    expect(await db.queueItem.count({ where: { orderId: o.id } })).toBe(1);
  });

  it("승인 중에 주문이 취소되면(입금 기한 자동 취소 등) 받은 돈을 전액 취소한다", async () => {
    const s = await setup();
    const o = await s.order();
    const p = await s.start(o.id);
    s.gw.failNext = "timeout_after";
    s.gw.netCancel = async () => ({ kind: "unknown", error: "timeout" });
    await confirmAuthResult(db, s.gw, s.gw.authorize(p.orderId, 13000));
    expect(await cancelPendingOrder(db, s.ctx, o.id, { reason: "기한 지남", expectedLiveVersion: await lv(s.seller.id) })).toMatchObject({ ok: true });
    expect(await reconcilePayment(db, s.gw, p.paymentId)).toBe("cancelled");
    expect(await paymentOf(p.paymentId)).toMatchObject({ status: "CANCELLED", cancelledAmount: 13000 });
    expect(s.gw.payments.get(`fake-tid-${p.paymentId}`)).toMatchObject({ status: "cancelled", balanceAmt: 0 });
    expect((await orderOf(o.id)).status).toBe("CANCELLED");
  });
});

describe("웹훅", () => {
  it("서명이 틀리면 거절하고, 맞으면 PG 조회로 승인 중 결제를 확정한다", async () => {
    const s = await setup();
    const o = await s.order();
    const p = await s.start(o.id);
    s.gw.failNext = "timeout_after";
    s.gw.netCancel = async () => ({ kind: "unknown", error: "timeout" });
    await confirmAuthResult(db, s.gw, s.gw.authorize(p.orderId, 13000));
    const tid = `fake-tid-${p.paymentId}`;
    expect(await handleWebhook(db, s.gw, { tid, status: "paid", signature: "forged" })).toBe("invalid_signature");
    expect((await paymentOf(p.paymentId)).status).toBe("APPROVING");
    expect(await handleWebhook(db, s.gw, { tid, signature: `fake-hook:${tid}` })).toBe("ok");
    expect((await orderOf(o.id)).status).toBe("PAID");
    // 모르는 tid는 무시(OK)
    expect(await handleWebhook(db, s.gw, { tid: "nope", signature: "fake-hook:nope" })).toBe("ok");
  });
});

describe("환불 → 결제 취소·부분 취소", () => {
  async function paidOrder() {
    const s = await setup();
    const o = await s.order();
    const p = await s.start(o.id);
    await confirmAuthResult(db, s.gw, s.gw.authorize(p.orderId, 13000));
    return { ...s, o, p, tid: `fake-tid-${p.paymentId}` };
  }

  it("환불하면 같은 트랜잭션에 취소 요청을 남기고, 처리하면 PG 전액 취소", async () => {
    const s = await paidOrder();
    const r = await refundOrder(db, s.ctx, s.o.id, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) });
    expect(r).toMatchObject({ ok: true, value: { refundAmount: 13000 } });
    const c = await db.paymentCancel.findFirstOrThrow({ where: { paymentId: s.p.paymentId } });
    expect(c).toMatchObject({ status: "REQUESTED", amount: 13000, idempotencyKey: `refund:${s.o.id}` });
    expect(s.gw.cancelCalls).toBe(0);
    expect(await processPaymentCancel(db, s.gw, c.id)).toBe("done");
    expect(await paymentOf(s.p.paymentId)).toMatchObject({ status: "CANCELLED", cancelledAmount: 13000 });
    expect(s.gw.payments.get(s.tid)).toMatchObject({ status: "cancelled", balanceAmt: 0 });
    // 다시 처리해도 PG를 다시 부르지 않는다
    expect(await processPaymentCancel(db, s.gw, c.id, new Date(Date.now() + CANCEL_RETRY_AFTER_MS * 2))).toBe("done");
    expect(s.gw.cancelCalls).toBe(1);
  });

  it("발송 뒤 구매자 사정 환불은 부분 취소(반품 배송비 차감액만큼)", async () => {
    const s = await paidOrder();
    await db.sellerShippingPolicy.upsert({ where: { sellerId: s.seller.id }, create: { sellerId: s.seller.id, returnFee: 3000 }, update: { returnFee: 3000 } });
    await db.orderShippingAddress.create({ data: { sellerId: s.seller.id, orderId: s.o.id, recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "주소 1" } });
    const { shipOrder } = await import("../../lib/server/orders/ship");
    expect(await shipOrder(db, s.ctx, s.o.id, { courier: "CJ", trackingNumber: "123456789012" })).toMatchObject({ ok: true });
    const r = await refundOrder(db, s.ctx, s.o.id, { reason: "단순 변심", fault: "BUYER", expectedLiveVersion: await lv(s.seller.id) });
    if (!r.ok) throw new Error(r.reason);
    const refund = r.value.refundAmount;
    expect(refund).toBeLessThan(13000);
    const c = await db.paymentCancel.findFirstOrThrow({ where: { paymentId: s.p.paymentId } });
    expect(c.amount).toBe(refund);
    expect(await processPaymentCancel(db, s.gw, c.id)).toBe("done");
    expect(await paymentOf(s.p.paymentId)).toMatchObject({ status: "PARTIAL_CANCELLED", cancelledAmount: refund });
    expect(s.gw.payments.get(s.tid)).toMatchObject({ status: "partialCancelled", balanceAmt: 13000 - refund });
  });

  it("동시에 두 번 처리해도 PG 취소는 한 번", async () => {
    const s = await paidOrder();
    await refundOrder(db, s.ctx, s.o.id, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) });
    const c = await db.paymentCancel.findFirstOrThrow({ where: { paymentId: s.p.paymentId } });
    await Promise.all([processPaymentCancel(db, s.gw, c.id), processPaymentCancel(db, s.gw, c.id), processPendingPayments(db, s.gw)]);
    expect(s.gw.cancelCalls).toBe(1);
    expect(await paymentOf(s.p.paymentId)).toMatchObject({ status: "CANCELLED", cancelledAmount: 13000 });
  });

  it("취소 응답을 잃으면 대기로 두고, 다시 보낼 때 PG 중복 거절을 조회로 확인해 한 번만 반영한다", async () => {
    const s = await paidOrder();
    await refundOrder(db, s.ctx, s.o.id, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) });
    const c = await db.paymentCancel.findFirstOrThrow({ where: { paymentId: s.p.paymentId } });
    // PG에서는 취소됐는데 응답도, 바로 한 조회도 실패한 경우
    s.gw.failNext = "timeout_after";
    const getPayment = s.gw.getPayment.bind(s.gw);
    s.gw.getPayment = async () => ({ kind: "unknown", error: "timeout" });
    expect(await processPaymentCancel(db, s.gw, c.id)).toBe("pending");
    s.gw.getPayment = getPayment;
    expect((await paymentOf(s.p.paymentId)).cancelledAmount).toBe(0);
    // 재시도 간격 전에는 다시 보내지 않는다
    expect(await processPaymentCancel(db, s.gw, c.id)).toBe("pending");
    expect(s.gw.cancelCalls).toBe(1);
    expect(await processPaymentCancel(db, s.gw, c.id, new Date(Date.now() + CANCEL_RETRY_AFTER_MS + 1000))).toBe("done");
    expect(s.gw.cancelCalls).toBe(2);
    expect(await paymentOf(s.p.paymentId)).toMatchObject({ status: "CANCELLED", cancelledAmount: 13000 });
    expect(s.gw.payments.get(s.tid)?.balanceAmt).toBe(0);
  });

  it("취소 응답만 잃은 경우 바로 조회해 확인되면 한 번에 반영한다", async () => {
    const s = await paidOrder();
    await refundOrder(db, s.ctx, s.o.id, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) });
    const c = await db.paymentCancel.findFirstOrThrow({ where: { paymentId: s.p.paymentId } });
    s.gw.failNext = "timeout_after";
    expect(await processPaymentCancel(db, s.gw, c.id)).toBe("done");
    expect(s.gw.cancelCalls).toBe(1);
    expect(await paymentOf(s.p.paymentId)).toMatchObject({ status: "CANCELLED", cancelledAmount: 13000 });
  });

  it("PG가 거절하면 실패로 남기고 로그 추적에 기록(자동으로 다시 보내지 않음)", async () => {
    const s = await paidOrder();
    await refundOrder(db, s.ctx, s.o.id, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) });
    const c = await db.paymentCancel.findFirstOrThrow({ where: { paymentId: s.p.paymentId } });
    s.gw.failNext = "reject";
    expect(await processPaymentCancel(db, s.gw, c.id)).toBe("failed");
    expect(await db.paymentCancel.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: "FAILED", failureCode: "cancel_rejected" });
    expect(await db.auditLog.count({ where: { action: "payment.cancel_failed", targetId: s.o.id } })).toBe(1);
    expect((await paymentOf(s.p.paymentId)).cancelledAmount).toBe(0);
  });

  it("카드 결제가 없는 주문(무통장 입금 등)의 환불은 취소 요청을 만들지 않는다", async () => {
    const s = await setup();
    const o = await s.order();
    const { markOrderPaid } = await import("../../lib/server/queue/service");
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.id, paymentMethod: "BANK_TRANSFER" });
    expect(await refundOrder(db, s.ctx, o.id, { reason: "구매자 요청", expectedLiveVersion: await lv(s.seller.id) })).toMatchObject({ ok: true });
    expect(await db.paymentCancel.count()).toBe(0);
  });
});

describe("DB 제약", () => {
  it("같은 주문에 결제 완료 결제를 두 개 둘 수 없고, 취소 합계가 결제 금액을 넘을 수 없다", async () => {
    const s = await setup();
    const o = await s.order();
    await db.payment.create({ data: { sellerId: s.seller.id, orderId: o.id, provider: "fake", method: "CARD", amount: 13000, status: "PAID", pgTid: "t1" } });
    await expect(db.payment.create({ data: { sellerId: s.seller.id, orderId: o.id, provider: "fake", method: "CARD", amount: 13000, status: "APPROVING", pgTid: "t2" } })).rejects.toThrow();
    await expect(db.payment.updateMany({ where: { pgTid: "t1" }, data: { cancelledAmount: 13001 } })).rejects.toThrow();
  });
});

describe("경로", () => {
  const origin = "http://localhost:3000";
  const startReq = (slug: string, cookie: string | undefined, body: unknown) =>
    startRoute(
      new Request(`${origin}/api/shop/${slug}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost:3000", origin, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ slug }) },
    );

  async function buyerShop() {
    const s = await setup();
    const login = await createLoginBuyer(s.seller.id, s.grade.id);
    const r = await loginBuyer(db, { sellerId: s.seller.id, loginId: login.loginId, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    const o = await s.order({ buyerMemberId: login.id });
    return { ...s, cookie: `lo_buyer=${r.token}`, o };
  }

  it("나이스페이 키가 없으면 503 결제 준비 중(결제 행을 만들지 않음)", async () => {
    const s = await buyerShop();
    setPaymentGatewayForTest(null);
    const res = await startReq(s.seller.slug, s.cookie, { orderId: s.o.id });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "payment_not_ready", message: PAYMENT_MESSAGES.payment_not_ready });
    expect(await db.payment.count()).toBe(0);
  });

  it("결제 시작 → 인증 결과(returnUrl) → 주문 화면으로 303, 웹훅은 OK 본문", async () => {
    const s = await buyerShop();
    setPaymentGatewayForTest(s.gw);
    expect((await startReq(s.seller.slug, undefined, { orderId: s.o.id })).status).toBe(401);
    expect((await startReq(s.seller.slug, s.cookie, { orderId: 1 })).status).toBe(400);
    const res = await startReq(s.seller.slug, s.cookie, { orderId: s.o.id, amount: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({ clientId: "fake-client", method: "card", amount: 13000, returnUrl: `${origin}/api/payments/nicepay/return` });

    // 위조 서명은 400, 상태 그대로
    const auth = s.gw.authorize(body.orderId, 13000);
    const post = (fields: Record<string, string>) => returnRoute(new Request(`${origin}/api/payments/nicepay/return`, { method: "POST", body: new URLSearchParams(fields) }));
    expect((await post({ ...auth, signature: "x" })).status).toBe(400);
    const back = await post(auth);
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`${origin}/shop/${s.seller.slug}/orders?orderId=${s.o.id}&payment=paid`);
    expect((await orderOf(s.o.id)).status).toBe("PAID");

    const tid = `fake-tid-${body.paymentId}`;
    const hook = await webhookRoute(new Request(`${origin}/api/payments/nicepay/webhook`, { method: "POST", body: JSON.stringify({ tid, signature: `fake-hook:${tid}` }) }));
    expect(hook.status).toBe(200);
    expect(await hook.text()).toBe("OK");
    const bad = await webhookRoute(new Request(`${origin}/api/payments/nicepay/webhook`, { method: "POST", body: JSON.stringify({ tid, signature: "x" }) }));
    expect(bad.status).toBe(401);
  });
});
