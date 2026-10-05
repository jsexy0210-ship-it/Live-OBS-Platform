import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as previewRoute } from "../../app/api/seller/orders/[orderId]/refund/preview/route";
import { POST as refundRoute } from "../../app/api/seller/orders/[orderId]/refund/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES_FORMAL } from "../../lib/server/orders/messages";
import { markOrderPaid, previewRefundSelection, refundOrder, type RefundSelection } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 부분 환불(SA-023, MASTER 배정 2026-10-05): 품목·수량을 골라 여러 번 나눠 환불한다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };

// 두 품목(A 5,000원 × 3 · B 7,000원 × 1) 결제 완료 카드 주문, 배송비 3,000원. rewardUse면 적립금을 쓴다.
async function setup(opts: { rewardUse?: number } = {}) {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터", price: 5000, status: "ON_SALE" } });
  const a = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "팩", stock: 50 } });
  const b = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "박스", priceDelta: 2000, stock: 50 } });
  if (opts.rewardUse) {
    await db.rewardPolicy.create({ data: { sellerId: seller.id, livePayoutEnabled: true } });
    await db.rewardBalance.create({ data: { sellerId: seller.id, buyerMemberId: buyer.id, balance: 10000 } });
  }
  const o = await createOrder(db, {
    sellerId: seller.id,
    buyerMemberId: buyer.id,
    items: [
      { optionId: a.id, quantity: 3 },
      { optionId: b.id, quantity: 1 },
    ],
    consent,
    shippingAddress: addr,
    rewardUseAmount: opts.rewardUse,
  });
  if (!o.ok) throw new Error(o.reason);
  const paid = await markOrderPaid(db, { sellerId: seller.id, orderId: o.orderId, paymentMethod: "CARD" });
  if (!paid.ok) throw new Error(paid.reason);
  const order = await db.order.findUniqueOrThrow({ where: { id: o.orderId } });
  const payment = await db.payment.create({ data: { sellerId: seller.id, orderId: o.orderId, provider: "fake", method: "CARD", status: "PAID", amount: order.totalAmount, approvedAt: new Date() } });
  const items = await db.orderItem.findMany({ where: { orderId: o.orderId } });
  const itemA = items.find((i) => i.optionId === a.id)!;
  const itemB = items.find((i) => i.optionId === b.id)!;
  const queueOf = (id: string) => db.queueItem.findUniqueOrThrow({ where: { sellerId_orderItemId: { sellerId: seller.id, orderItemId: id } } });
  return { seller, owner, ctx, buyer, a, b, order, payment, itemA, itemB, queueOf };
}

const lv = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;
const stockOf = async (id: string) => (await db.productOption.findUniqueOrThrow({ where: { id } })).stock;
const balanceOf = async (sellerId: string, buyerMemberId: string) =>
  (await db.rewardBalance.findUniqueOrThrow({ where: { sellerId_buyerMemberId: { sellerId, buyerMemberId } } })).balance;

async function refund(s: Awaited<ReturnType<typeof setup>>, items: RefundSelection | undefined, extra: { fault?: "BUYER" | "SELLER"; confirmOpened?: boolean } = {}) {
  const p = await previewRefundSelection(db, s.ctx, s.order.id, items);
  if (!p.ok) return { ok: false as const, reason: p.reason, preview: null };
  const fault = extra.fault ?? "SELLER";
  const r = await refundOrder(db, s.ctx, s.order.id, {
    reason: "부분 환불",
    expectedLiveVersion: await lv(s.seller.id),
    fault: extra.fault,
    confirmOpened: extra.confirmOpened,
    expectedRefundAmount: p.value.byFault[fault].refundAmount,
    items,
  });
  return { ...r, preview: p.value };
}

describe("부분 환불", () => {
  it("품목을 나눠 두 번 환불: 첫 환불은 주문을 결제 완료로 두고 배송비는 마지막에, PG 취소는 환불마다 따로이며 합은 결제 금액", async () => {
    const s = await setup();
    expect(s.order.totalAmount).toBe(15000 + 7000 + 3000);
    const first = await refund(s, [{ orderItemId: s.itemB.id, quantity: 1 }]);
    expect(first).toMatchObject({ ok: true, value: { refundAmount: 7000, isFinal: false, seq: 1, cancelledQueueItemIds: [expect.any(String)] } });
    expect(first.preview).toMatchObject({ isFinal: false, byFault: { SELLER: { itemsAmount: 7000, shippingRefunded: 0, refundAmount: 7000 } } });
    let order = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
    expect(order).toMatchObject({ status: "PAID", refundAmount: 7000, refundedAt: null });
    expect((await s.queueOf(s.itemB.id)).status).toBe("CANCELLED");
    expect((await s.queueOf(s.itemA.id)).status).toBe("WAITING");
    expect(await stockOf(s.b.id)).toBe(50); // 발송 전·개봉 전이라 되돌림
    expect(await db.auditLog.count({ where: { action: "order.refund_partial", targetId: s.order.id } })).toBe(1);

    // 남은 미리보기: A 3개만 남았고 이번이 마지막
    const rest = await previewRefundSelection(db, s.ctx, s.order.id);
    expect(rest).toMatchObject({ ok: true, value: { isFinal: true, refundedAmount: 7000, byFault: { SELLER: { itemsAmount: 15000, shippingRefunded: 3000, refundAmount: 18000 } } } });
    if (!rest.ok) return;
    // 두 품목은 같은 시각에 만들어져 목록 순서는 id로 정해진다. 순서 대신 품목 id로 찾아 비교한다
    const left = (id: string) => rest.value.items.find((i) => i.orderItemId === id);
    expect(left(s.itemA.id)).toMatchObject({ refundedQuantity: 0, refundableQuantity: 3 });
    expect(left(s.itemB.id)).toMatchObject({ refundedQuantity: 1, refundableQuantity: 0 });
    const second = await refund(s, undefined);
    expect(second).toMatchObject({ ok: true, value: { refundAmount: 18000, isFinal: true, seq: 2 } });
    order = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
    expect(order).toMatchObject({ status: "REFUNDED", refundAmount: s.order.totalAmount });
    const cancels = await db.paymentCancel.findMany({ where: { paymentId: s.payment.id }, orderBy: { createdAt: "asc" } });
    expect(cancels.map((c) => [c.idempotencyKey, c.amount])).toEqual([
      [`refund:${s.order.id}:1`, 7000],
      [`refund:${s.order.id}:2`, 18000],
    ]);
    expect(await db.orderRefund.count({ where: { orderId: s.order.id } })).toBe(2);
    // 환불이 끝난 주문은 더 환불할 수 없다
    expect(await refundOrder(db, s.ctx, s.order.id, { reason: "x", expectedLiveVersion: await lv(s.seller.id), expectedRefundAmount: 0 })).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("한 번에 전부 환불하면 지금과 같은 멱등 키(refund:{orderId})를 쓴다", async () => {
    const s = await setup();
    expect(await refund(s, undefined)).toMatchObject({ ok: true, value: { isFinal: true, seq: 1, refundAmount: s.order.totalAmount } });
    expect((await db.paymentCancel.findMany({ where: { paymentId: s.payment.id } })).map((c) => c.idempotencyKey)).toEqual([`refund:${s.order.id}`]);
  });

  it("개봉 대기 중인 품목은 수량 일부만 환불할 수 없다(409). 대기에서 빠진 품목은 수량 일부 환불이 되고, 재고는 그 품목을 다 돌려줄 때 한꺼번에 되돌린다", async () => {
    const s = await setup();
    expect(await refund(s, [{ orderItemId: s.itemA.id, quantity: 1 }])).toMatchObject({ ok: false, reason: "queued_item_partial" });
    await db.queueItem.update({ where: { id: (await s.queueOf(s.itemA.id)).id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    expect(await stockOf(s.a.id)).toBe(47);
    const one = await refund(s, [{ orderItemId: s.itemA.id, quantity: 1 }]);
    expect(one).toMatchObject({ ok: true, value: { refundAmount: 5000, restockedItemIds: [] } });
    expect(await stockOf(s.a.id)).toBe(47);
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: s.itemA.id } })).refundedQuantity).toBe(1);
    const two = await refund(s, [{ orderItemId: s.itemA.id, quantity: 2 }]);
    expect(two).toMatchObject({ ok: true, value: { refundAmount: 10000, restockedItemIds: [s.itemA.id], isFinal: false } });
    expect(await stockOf(s.a.id)).toBe(50);
    // 남은 수량을 넘거나 다 돌려준 품목·없는 품목·같은 품목 두 번·0개는 400
    for (const bad of [
      [{ orderItemId: s.itemA.id, quantity: 1 }],
      [{ orderItemId: s.itemB.id, quantity: 2 }],
      [{ orderItemId: s.order.id, quantity: 1 }],
      [
        { orderItemId: s.itemB.id, quantity: 1 },
        { orderItemId: s.itemB.id, quantity: 1 },
      ],
      [{ orderItemId: s.itemB.id, quantity: 0 }],
    ]) {
      expect(await refundOrder(db, s.ctx, s.order.id, { reason: "x", expectedLiveVersion: await lv(s.seller.id), items: bad }), JSON.stringify(bad)).toEqual({ ok: false, reason: "invalid_refund_items" });
    }
    expect(await db.orderRefund.count({ where: { orderId: s.order.id } })).toBe(2);
  });

  it("발송 전 개봉한 품목이 있어도 개봉하지 않은 품목만 골라 구매자 사정으로 부분 환불할 수 있다. 개봉한 품목을 고르면 409", async () => {
    const s = await setup();
    await db.queueItem.update({ where: { id: (await s.queueOf(s.itemA.id)).id }, data: { status: "DONE", openingStartedAt: new Date(), doneAt: new Date() } });
    expect(await refund(s, [{ orderItemId: s.itemA.id, quantity: 3 }], { fault: "BUYER", confirmOpened: true })).toMatchObject({ ok: false, reason: "opened_items_unshipped" });
    const ok = await refund(s, [{ orderItemId: s.itemB.id, quantity: 1 }], { fault: "BUYER" });
    expect(ok).toMatchObject({ ok: true, value: { refundAmount: 7000, isFinal: false, openedItemCount: 0 } });
    expect((await db.order.findUniqueOrThrow({ where: { id: s.order.id } })).status).toBe("PAID");
  });

  it("적립금 사용 주문: 환불마다 누적 비율로 돌려주고(10원 내림) 마지막 환불이 남은 전액, 현금 + 적립금 = 상품 + 배송비", async () => {
    const s = await setup({ rewardUse: 3010 });
    expect(s.order.totalAmount).toBe(25000 - 3010);
    const first = await refund(s, [{ orderItemId: s.itemB.id, quantity: 1 }]);
    // 3,010 × 7,000 ÷ 22,000 = 957.7… → 950
    expect(first).toMatchObject({ ok: true, value: { rewardReturn: 950, refundAmount: 7000 - 950 } });
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(10000 - 3010 + 950);
    const second = await refund(s, undefined);
    expect(second).toMatchObject({ ok: true, value: { rewardReturn: 3010 - 950, refundAmount: 15000 + 3000 - 2060, isFinal: true } });
    expect(await balanceOf(s.seller.id, s.buyer.id)).toBe(10000);
    const ledger = await db.rewardLedger.findMany({ where: { orderId: s.order.id, type: "USE", amount: { gt: 0 } }, orderBy: { createdAt: "asc" } });
    expect(ledger.map((l) => [l.idempotencyKey, l.amount])).toEqual([
      [`use_return:${s.order.id}:1`, 950],
      [`use_return:${s.order.id}:2`, 2060],
    ]);
    const cash = (await db.orderRefund.findMany({ where: { orderId: s.order.id } })).reduce((a, r) => a + r.refundAmount, 0);
    expect(cash).toBe(s.order.totalAmount);
  });

  it("주문 적립 회수: 기록된 적립은 환불 수량 비율만큼 회수 원장, 기록 전(배송 완료 적립)이면 적립 예정액을 줄이고 미리보기 금액과 같다", async () => {
    const s = await setup();
    await db.rewardLedger.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, orderId: s.order.id, type: "EARN", amount: 220, status: "PENDING", testMode: false, idempotencyKey: `earn:${s.order.id}` } });
    const p = await previewRefundSelection(db, s.ctx, s.order.id, [{ orderItemId: s.itemB.id, quantity: 1 }]);
    // 적립 기준액 22,000 중 7,000 → 220 × 7/22 = 70
    expect(p).toMatchObject({ ok: true, value: { rewardRevoke: { amount: 70, kind: "ledger" } } });
    expect(await refund(s, [{ orderItemId: s.itemB.id, quantity: 1 }])).toMatchObject({ ok: true, value: { rewardRevoke: "revoked", rewardRevokeAmount: 70 } });
    expect(await refund(s, undefined)).toMatchObject({ ok: true, value: { rewardRevokeAmount: 150 } });
    const revokes = await db.rewardLedger.findMany({ where: { orderId: s.order.id, type: "REVOKE" }, orderBy: { createdAt: "asc" } });
    expect(revokes.map((r) => [r.idempotencyKey, r.amount])).toEqual([
      [`revoke:${s.order.id}:1`, -70],
      [`revoke:${s.order.id}:2`, -150],
    ]);

    const t = await setup();
    await db.order.update({ where: { id: t.order.id }, data: { rewardEarnTiming: "ON_DELIVERY", rewardEarnAmount: 220 } });
    expect(await previewRefundSelection(db, t.ctx, t.order.id, [{ orderItemId: t.itemB.id, quantity: 1 }])).toMatchObject({ ok: true, value: { rewardRevoke: { amount: 70, kind: "pending" } } });
    expect(await refund(t, [{ orderItemId: t.itemB.id, quantity: 1 }])).toMatchObject({ ok: true, value: { rewardRevoke: "none", rewardRevokeAmount: 70 } });
    expect((await db.order.findUniqueOrThrow({ where: { id: t.order.id } })).rewardEarnAmount).toBe(150);
    expect(await db.rewardLedger.count({ where: { orderId: t.order.id } })).toBe(0);
  });

  it("같은 주문을 동시에 부분 환불하면 하나만 되고(나머지 conflict), 같은 요청을 다시 보내도 두 번 환불하지 않는다", async () => {
    const s = await setup();
    const version = await lv(s.seller.id);
    const sel = [{ orderItemId: s.itemB.id, quantity: 1 }];
    const rs = await Promise.all(
      [0, 1, 2].map(() => refundOrder(db, s.ctx, s.order.id, { reason: "동시", expectedLiveVersion: version, fault: "SELLER", expectedRefundAmount: 7000, items: sel })),
    );
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.filter((r) => !r.ok).map((r) => !r.ok && r.reason)).toEqual(["conflict", "conflict"]);
    // 새 버전으로 같은 품목을 다시 보내면 남은 수량이 없어 400
    expect(await refundOrder(db, s.ctx, s.order.id, { reason: "다시", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER", expectedRefundAmount: 7000, items: sel })).toEqual({
      ok: false,
      reason: "invalid_refund_items",
    });
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: s.itemB.id } })).refundedQuantity).toBe(1);
    expect(await db.paymentCancel.count({ where: { paymentId: s.payment.id } })).toBe(1);
    expect(await db.orderRefund.count({ where: { orderId: s.order.id } })).toBe(1);
  });

  it("동시에 서로 다른 품목을 최신 버전으로 환불해도 판매자 잠금으로 차례로 처리되고 금액 합이 맞다", async () => {
    const s = await setup();
    const one = async (items: RefundSelection, amount: number) => {
      for (let i = 0; i < 20; i++) {
        const r = await refundOrder(db, s.ctx, s.order.id, { reason: "동시", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER", items, expectedRefundAmount: amount });
        if (r.ok || r.reason !== "conflict") return r;
      }
      throw new Error("retry");
    };
    // B 먼저든 A 먼저든 마지막 환불이 배송비를 가져가므로 금액이 달라질 수 있어, 금액 확인 없이 보낸다
    const [rb, ra] = await Promise.all([
      one([{ orderItemId: s.itemB.id, quantity: 1 }], 7000).catch(() => null),
      refundOrder(db, s.ctx, s.order.id, { reason: "동시", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER", items: [{ orderItemId: s.itemA.id, quantity: 3 }] }),
    ]);
    const done = [rb, ra].filter((r) => r && r.ok);
    expect(done.length).toBeGreaterThanOrEqual(1);
    const refunds = await db.orderRefund.findMany({ where: { orderId: s.order.id } });
    expect(new Set(refunds.map((r) => r.seq)).size).toBe(refunds.length);
    const items = await db.orderItem.findMany({ where: { orderId: s.order.id } });
    for (const i of items) expect(i.refundedQuantity).toBeLessThanOrEqual(i.quantity);
    expect(refunds.reduce((a, r) => a + r.refundAmount, 0)).toBeLessThanOrEqual(s.order.totalAmount);
  });

  it("판매자 격리: 다른 판매자는 이 주문을 미리보기·환불할 수 없고, 다른 주문의 품목은 고를 수 없다", async () => {
    const s = await setup();
    const other = await setup();
    expect(await previewRefundSelection(db, other.ctx, s.order.id)).toEqual({ ok: false, reason: "not_found" });
    expect(await refundOrder(db, other.ctx, s.order.id, { reason: "x", expectedLiveVersion: await lv(other.seller.id), fault: "SELLER" })).toEqual({ ok: false, reason: "not_found" });
    expect(await refundOrder(db, s.ctx, s.order.id, { reason: "x", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER", items: [{ orderItemId: other.itemB.id, quantity: 1 }] })).toEqual({
      ok: false,
      reason: "invalid_refund_items",
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: s.order.id } })).status).toBe("PAID");
    expect(await db.orderRefund.count()).toBe(0);
  });

  it("경로: 미리보기 금액으로 환불하면 같은 금액, 잘못된 items는 400 합니다체 문구, 다른 판매자 세션은 404", async () => {
    const s = await setup();
    const other = await setup();
    const cookieOf = async (email: string) => {
      const l = await loginSeller(db, { email, password: PASSWORD }, {});
      if (!l.ok) throw new Error(l.reason);
      return `lo_seller=${l.token}`;
    };
    const cookie = await cookieOf(s.owner.email);
    const post = (route: typeof previewRoute, path: string, body: unknown, c = cookie) =>
      route(new Request(`http://localhost:3000/api/seller/orders/${s.order.id}/${path}`, { method: "POST", headers: { ...H, cookie: c }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ orderId: s.order.id }),
      });
    const items = [{ orderItemId: s.itemB.id, quantity: 1 }];
    const pv = await post(previewRoute, "refund/preview", { items });
    expect(pv.status).toBe(200);
    expect(pv.headers.get("cache-control")).toBe("no-store");
    const preview = await pv.json();
    expect(preview).toMatchObject({ isFinal: false, byFault: { SELLER: { refundAmount: 7000 } }, items: expect.any(Array) });
    for (const bad of [{ items: [] }, { items: [{ orderItemId: "x", quantity: 1 }] }, { items: [{ orderItemId: s.itemB.id, quantity: 1.5 }] }, { items: "all" }]) {
      const r = await post(previewRoute, "refund/preview", bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_refund_items", message: ORDER_ERROR_MESSAGES_FORMAL.invalid_refund_items });
    }
    expect((await post(previewRoute, "refund/preview", { items }, await cookieOf(other.owner.email))).status).toBe(404);
    const queued = await post(previewRoute, "refund/preview", { items: [{ orderItemId: s.itemA.id, quantity: 1 }] });
    expect(queued.status).toBe(409);
    expect(await queued.json()).toEqual({ error: "queued_item_partial", message: ORDER_ERROR_MESSAGES_FORMAL.queued_item_partial });

    const r = await post(refundRoute, "refund", { reason: "부분", expectedVersion: await lv(s.seller.id), fault: "SELLER", expectedRefundAmount: preview.byFault.SELLER.refundAmount, items });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ refundAmount: 7000, isFinal: false, seq: 1 });
    const bad = await post(refundRoute, "refund", { reason: "부분", expectedVersion: await lv(s.seller.id), fault: "SELLER", expectedRefundAmount: 0, items: [{ orderItemId: s.itemB.id }] });
    expect(bad.status).toBe(400);
  });
});
