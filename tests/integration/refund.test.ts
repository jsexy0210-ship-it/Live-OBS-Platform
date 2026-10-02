import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyQueueAction, cancelPendingOrder, markOrderPaid, refundOrder, startBroadcast } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { POST as cancelRoute } from "../../app/api/seller/orders/[orderId]/cancel/route";
import { POST as refundRoute } from "../../app/api/seller/orders/[orderId]/refund/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createBuyer(seller.id, grade.id);
  let orderNo = 0;
  async function pendingOrder(lines: [number, number][], total = 10000) {
    const order = await db.order.create({
      data: { sellerId: seller.id, orderNo: ++orderNo, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: total },
    });
    const options = [];
    for (const [stock, quantity] of lines) {
      const product = await db.product.create({ data: { sellerId: seller.id, name: "팩", price: 5000, status: "ON_SALE" } });
      const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1팩", stock } });
      await db.orderItem.create({
        data: { sellerId: seller.id, orderId: order.id, productId: product.id, optionId: option.id, productNameSnapshot: "팩", optionNameSnapshot: "1팩", unitPrice: 5000, quantity },
      });
      options.push(option);
    }
    return { order, options };
  }
  async function paid(lines: [number, number][] = [[10, 2]], method: "CARD" | "BANK_TRANSFER" = "CARD") {
    const p = await pendingOrder(lines);
    const r = await markOrderPaid(db, { sellerId: seller.id, orderId: p.order.id, paymentMethod: method });
    if (!r.ok) throw new Error(r.reason);
    return { ...p, queueItemIds: r.value.queueItemIds, shortage: r.value.stockShortage };
  }
  return { seller, grade, ctx, buyer, owner, pendingOrder, paid };
}

const stockOf = async (id: string) => (await db.productOption.findUniqueOrThrow({ where: { id } })).stock;
const queueStatus = async (id: string) => (await db.queueItem.findUniqueOrThrow({ where: { id } })).status;
const lv = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;
const v = async (id: string) => (await db.queueItem.findUniqueOrThrow({ where: { id } })).version;

describe("환불: 개봉 전 품목만 재고 복구, 연결된 대기·개봉 중 자동 취소", () => {
  it("대기 중이면 주문대기를 취소하고 재고를 되돌린다", async () => {
    const s = await setup();
    const { order, options, queueItemIds } = await s.paid([[10, 2]]);
    expect(await stockOf(options[0].id)).toBe(8);
    const r = await refundOrder(db, s.ctx, order.id, { reason: "구매자 요청", expectedLiveVersion: await lv(s.ctx.sellerId) });
    expect(r).toMatchObject({ ok: true, value: { restockedItemIds: [expect.any(String)], cancelledQueueItemIds: queueItemIds } });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("REFUNDED");
    expect(await queueStatus(queueItemIds[0])).toBe("CANCELLED");
    expect(await stockOf(options[0].id)).toBe(10);
    expect(await db.stockMovement.count({ where: { orderId: order.id, reason: "REFUND", delta: 2 } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "order.refund", targetId: order.id } })).toBe(1);
  });

  it("개봉 중이면 확인(confirmOpened) 없이는 409, 확인하면 주문대기는 취소하고 재고는 되돌리지 않는다", async () => {
    const s = await setup();
    await startBroadcast(db, s.ctx);
    const { order, options, queueItemIds } = await s.paid([[10, 1]]);
    await applyQueueAction(db, s.ctx, queueItemIds[0], "start", { expectedVersion: await v(queueItemIds[0]) });
    expect(await refundOrder(db, s.ctx, order.id, { reason: "요청", expectedLiveVersion: await lv(s.ctx.sellerId) })).toEqual({
      ok: false,
      reason: "opened_items_present",
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await queueStatus(queueItemIds[0])).toBe("OPENING");
    const r = await refundOrder(db, s.ctx, order.id, { reason: "배송 사고", expectedLiveVersion: await lv(s.ctx.sellerId), confirmOpened: true });
    expect(r).toMatchObject({ ok: true, value: { restockedItemIds: [], cancelledQueueItemIds: queueItemIds } });
    expect(await queueStatus(queueItemIds[0])).toBe("CANCELLED");
    expect(await stockOf(options[0].id)).toBe(9);
  });

  it("개봉을 마쳤으면 주문대기는 그대로 두고 재고도 되돌리지 않는다", async () => {
    const s = await setup();
    await startBroadcast(db, s.ctx);
    const { order, options, queueItemIds } = await s.paid([[10, 1]]);
    await applyQueueAction(db, s.ctx, queueItemIds[0], "start");
    await applyQueueAction(db, s.ctx, queueItemIds[0], "complete");
    expect(
      await refundOrder(db, s.ctx, order.id, { reason: "요청", expectedLiveVersion: await lv(s.ctx.sellerId), confirmOpened: true }),
    ).toMatchObject({ ok: true, value: { restockedItemIds: [], cancelledQueueItemIds: [], openedItemCount: 1 } });
    expect(await queueStatus(queueItemIds[0])).toBe("DONE");
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "order.refund", targetId: order.id } });
    expect(audit.after).toMatchObject({ status: "REFUNDED", openedItems: 1 });
    expect(await stockOf(options[0].id)).toBe(9);
  });

  it("개봉 전에 취소된 항목은 재고를 되돌리고, 개봉을 시작한 뒤 취소된 항목은 되돌리지 않는다", async () => {
    const s = await setup();
    await startBroadcast(db, s.ctx);
    const { order, options, queueItemIds } = await s.paid([
      [10, 1],
      [10, 1],
    ]);
    await applyQueueAction(db, s.ctx, queueItemIds[0], "cancel", { reason: "개봉 전 취소" });
    await applyQueueAction(db, s.ctx, queueItemIds[1], "start");
    await applyQueueAction(db, s.ctx, queueItemIds[1], "cancel", { reason: "개봉 중 취소" });
    const r = await refundOrder(db, s.ctx, order.id, { reason: "요청", expectedLiveVersion: await lv(s.ctx.sellerId), confirmOpened: true });
    expect(r.ok && r.value.restockedItemIds.length).toBe(1);
    expect(await stockOf(options[0].id)).toBe(10);
    expect(await stockOf(options[1].id)).toBe(9);
  });

  it("같은 주문을 두 번 환불할 수 없고 재고도 한 번만 되돌린다 (동시 요청 포함)", async () => {
    const s = await setup();
    const { order, options } = await s.paid([[10, 3]]);
    const at = await lv(s.ctx.sellerId);
    const results = await Promise.all([
      refundOrder(db, s.ctx, order.id, { reason: "a", expectedLiveVersion: at }),
      refundOrder(db, s.ctx, order.id, { reason: "b", expectedLiveVersion: at }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: "conflict" });
    expect(await refundOrder(db, s.ctx, order.id, { reason: "c", expectedLiveVersion: await lv(s.ctx.sellerId) })).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await stockOf(options[0].id)).toBe(10);
    expect(await db.stockMovement.count({ where: { orderId: order.id, reason: "REFUND" } })).toBe(1);
  });

  it("재고 부족으로 차감되지 않은 주문은 되돌릴 재고가 없다", async () => {
    const s = await setup();
    const { order, options, shortage } = await s.paid([
      [5, 1],
      [0, 1],
    ]);
    expect(shortage).toBe(true);
    expect(await refundOrder(db, s.ctx, order.id, { reason: "재고 부족", expectedLiveVersion: await lv(s.ctx.sellerId) })).toMatchObject({ ok: true, value: { restockedItemIds: [] } });
    expect([await stockOf(options[0].id), await stockOf(options[1].id)]).toEqual([5, 0]);
  });
});

describe("결제 전 취소", () => {
  it("결제 대기 주문은 취소되고, 결제 완료 주문은 취소 대신 환불해야 한다", async () => {
    const s = await setup();
    const { order } = await s.pendingOrder([[10, 1]]);
    expect(await cancelPendingOrder(db, s.ctx, order.id, { reason: "입금 안 함", expectedLiveVersion: await lv(s.ctx.sellerId) })).toMatchObject({ ok: true });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("CANCELLED");
    expect(await cancelPendingOrder(db, s.ctx, order.id, { reason: "x", expectedLiveVersion: await lv(s.ctx.sellerId) })).toEqual({ ok: false, reason: "invalid_transition" });
    const paid = await s.paid();
    expect(await cancelPendingOrder(db, s.ctx, paid.order.id, { reason: "x", expectedLiveVersion: await lv(s.ctx.sellerId) })).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await refundOrder(db, s.ctx, order.id, { reason: "x", expectedLiveVersion: await lv(s.ctx.sellerId) })).toEqual({ ok: false, reason: "invalid_transition" });
  });
});

describe("화면이 본 상태(version) 확인", () => {
  it("환불·취소는 version이 다르면 409(conflict)이고 아무것도 바뀌지 않는다", async () => {
    const s = await setup();
    const { order, options } = await s.paid([[10, 1]]);
    const stale = (await lv(s.ctx.sellerId)) - 1;
    expect(await refundOrder(db, s.ctx, order.id, { reason: "요청", expectedLiveVersion: stale })).toEqual({ ok: false, reason: "conflict" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect(await stockOf(options[0].id)).toBe(9);
    const pending = await s.pendingOrder([[10, 1]]);
    expect(await cancelPendingOrder(db, s.ctx, pending.order.id, { reason: "x", expectedLiveVersion: stale })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect((await db.order.findUniqueOrThrow({ where: { id: pending.order.id } })).status).toBe("PENDING_PAYMENT");
  });

  it("취소 사유는 앞뒤 공백을 지워 저장하고, 감사 로그에 전·후 상태를 남긴다", async () => {
    const s = await setup();
    const { order } = await s.pendingOrder([[10, 1]]);
    expect(await cancelPendingOrder(db, s.ctx, order.id, { reason: "  입금 안 함  ", expectedLiveVersion: await lv(s.ctx.sellerId) })).toMatchObject({ ok: true });
    const hist = await db.orderStatusHistory.findFirstOrThrow({ where: { orderId: order.id, toStatus: "CANCELLED" } });
    expect(hist.reason).toBe("입금 안 함");
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "order.cancel", targetId: order.id } });
    expect(audit).toMatchObject({ reason: "입금 안 함", before: { status: "PENDING_PAYMENT" }, after: { status: "CANCELLED" } });
  });
});

describe("적립금 원장", () => {
  async function withPolicy(s: Awaited<ReturnType<typeof setup>>, livePayoutEnabled = false) {
    await db.rewardPolicy.create({ data: { sellerId: s.seller.id, rates: { [s.grade.id]: { card: 1, bankTransfer: 3 } }, livePayoutEnabled } });
  }

  it("결제 완료 시 등급·결제수단 적립률로 지급 대기(EARN, 실지급 꺼짐이면 testMode)를 기록한다", async () => {
    const s = await setup();
    await withPolicy(s);
    const { order } = await s.paid([[10, 1]], "BANK_TRANSFER");
    const earn = await db.rewardLedger.findFirstOrThrow({ where: { orderId: order.id } });
    // 상품 금액 5,000원 × 계좌이체 3% (주문 totalAmount 10,000원은 기준이 아님)
    expect(earn).toMatchObject({ type: "EARN", amount: 150, status: "PENDING", testMode: true, idempotencyKey: `earn:${order.id}` });
    expect(await db.rewardBalance.count()).toBe(0);
  });

  it("환불하면 회수 대기(REVOKE)를 한 번만 기록한다", async () => {
    const s = await setup();
    await withPolicy(s, true);
    const { order } = await s.paid([[10, 1]], "CARD");
    expect(await refundOrder(db, s.ctx, order.id, { reason: "요청", expectedLiveVersion: await lv(s.ctx.sellerId) })).toMatchObject({ ok: true, value: { rewardRevoke: "revoked" } });
    const rows = await db.rewardLedger.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.type, r.amount, r.status, r.testMode])).toEqual([
      ["EARN", 50, "PENDING", false],
      ["REVOKE", -50, "PENDING", false],
    ]);
  });

  it("회수 방식이 MANUAL이면 환불해도 REVOKE를 만들지 않고 수동 확인 대기로 남긴다", async () => {
    const s = await setup();
    await db.rewardPolicy.create({ data: { sellerId: s.seller.id, rates: { [s.grade.id]: { card: 1 } }, revokeMode: "MANUAL" } });
    const { order } = await s.paid([[10, 1]], "CARD");
    expect(await refundOrder(db, s.ctx, order.id, { reason: "요청", expectedLiveVersion: await lv(s.ctx.sellerId) })).toMatchObject({
      ok: true,
      value: { rewardRevoke: "manual_review" },
    });
    expect((await db.rewardLedger.findMany({ where: { orderId: order.id } })).map((r) => r.type)).toEqual(["EARN"]);
    const audit = await db.auditLog.findFirstOrThrow({ where: { action: "order.refund", targetId: order.id } });
    expect(audit.after).toMatchObject({ rewardRevoke: "manual_review" });
  });

  it("결제수단을 넘기지 않으면 주문에 저장된 결제수단으로 적립한다", async () => {
    const s = await setup();
    await withPolicy(s);
    const { order } = await s.pendingOrder([[10, 1]]);
    await db.order.update({ where: { id: order.id }, data: { paymentMethod: "BANK_TRANSFER" } });
    const r = await markOrderPaid(db, { sellerId: s.seller.id, orderId: order.id });
    expect(r.ok).toBe(true);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).paymentMethod).toBe("BANK_TRANSFER");
    expect((await db.rewardLedger.findFirstOrThrow({ where: { orderId: order.id } })).amount).toBe(150);
  });

  it("적립 기준액 = 상품 금액(단가×수량, 배송비 제외) − 적립금 사용액, 적립금을 두 번 빼지 않는다", async () => {
    const s = await setup();
    await withPolicy(s);
    // 상품 2 × 5,000 = 10,000원, 적립금 2,000원 사용 → 결제액(totalAmount, 배송비 3,000 포함) 11,000원
    const { order } = await s.pendingOrder([[10, 2]], 11000);
    await db.order.update({ where: { id: order.id }, data: { rewardUsedAmount: 2000 } });
    expect((await markOrderPaid(db, { sellerId: s.seller.id, orderId: order.id, paymentMethod: "BANK_TRANSFER" })).ok).toBe(true);
    // 기준액 8,000원 × 3% = 240원 (totalAmount를 기준으로 쓰면 270, 적립금을 두 번 빼면 180)
    expect((await db.rewardLedger.findFirstOrThrow({ where: { orderId: order.id } })).amount).toBe(240);
  });

  it("정책이 없거나 재고 부족이면 기록하지 않는다", async () => {
    const s = await setup();
    await s.paid([[10, 1]]);
    expect(await db.rewardLedger.count()).toBe(0);
    await withPolicy(s);
    await s.paid([[0, 1]]);
    expect(await db.rewardLedger.count()).toBe(0);
  });
});

describe("권한·입력", () => {
  it("사유가 없으면 거부, ORDER_SHIPPING이 없으면 403, 다른 판매자 주문은 없음", async () => {
    const s = await setup();
    const { order } = await s.paid();
    expect(await refundOrder(db, s.ctx, order.id, { reason: " ", expectedLiveVersion: await lv(s.ctx.sellerId) })).toEqual({ ok: false, reason: "reason_required" });
    const caster: TenantContext = { ...s.ctx, isOwner: false, permissions: ["BROADCAST_RUN"] };
    await expect(refundOrder(db, caster, order.id, { reason: "x", expectedLiveVersion: await lv(caster.sellerId) })).rejects.toMatchObject({ status: 403 });
    const other = await setup();
    expect(await refundOrder(db, other.ctx, order.id, { reason: "x", expectedLiveVersion: await lv(other.ctx.sellerId) })).toEqual({ ok: false, reason: "not_found" });
    const ro: TenantContext = { ...s.ctx, actorType: "PLATFORM_ADMIN", isOwner: false, permissions: [], readOnly: true };
    await expect(refundOrder(db, ro, order.id, { reason: "x", expectedLiveVersion: await lv(ro.sellerId) })).rejects.toMatchObject({ status: 403 });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
  });
});

describe("HTTP: 환불·취소 API", () => {
  it("expectedVersion이 없으면 400, 개봉 항목이 있으면 confirmOpened 없이 409, 맞게 보내면 200", async () => {
    const s = await setup();
    const login = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const call = (route: typeof refundRoute, orderId: string, path: string, body: unknown) =>
      route(
        new Request(`http://localhost:3000/api/seller/orders/${orderId}/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000", cookie: `lo_seller=${login.token}` },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ orderId }) },
      );
    await startBroadcast(db, s.ctx);
    const { order, queueItemIds } = await s.paid([[10, 1]]);
    await applyQueueAction(db, s.ctx, queueItemIds[0], "start");
    expect((await call(refundRoute, order.id, "refund", { reason: "요청" })).status).toBe(400);
    const noConfirm = await call(refundRoute, order.id, "refund", { reason: "요청", expectedVersion: await lv(s.seller.id) });
    expect(noConfirm.status).toBe(409);
    expect(await noConfirm.json()).toEqual({ error: "opened_items_present" });
    expect((await call(refundRoute, order.id, "refund", { reason: "요청", expectedVersion: await lv(s.seller.id), confirmOpened: true })).status).toBe(200);

    const pending = await s.pendingOrder([[10, 1]]);
    expect((await call(cancelRoute, pending.order.id, "cancel", { reason: "x" })).status).toBe(400);
    expect((await call(cancelRoute, pending.order.id, "cancel", { reason: "x", expectedVersion: (await lv(s.seller.id)) - 1 })).status).toBe(409);
    expect((await call(cancelRoute, pending.order.id, "cancel", { reason: "x", expectedVersion: await lv(s.seller.id) })).status).toBe(200);
  });
});
