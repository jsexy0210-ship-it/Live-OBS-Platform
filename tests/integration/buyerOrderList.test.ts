import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { listBuyerOrders } from "../../lib/server/orders/buyer";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { markOrderPaid } from "../../lib/server/queue/service";
import { createLoginBuyer, createSeller, db, resetDb } from "./helpers";

// 구매자 주문 목록(SH-021) 추가 값(MASTER 배정 2026-10-06): 기간(from·to, 기본 최근 3개월), 탭 6개와 탭별 전체 개수, 주문 상품 사진, 개봉(대기열) 상태·앞 대기 수.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };

async function setup() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const other = await createLoginBuyer(seller.id, grade.id);
  let orderNo = 0;
  const make = (buyerMemberId: string, status: "PENDING_PAYMENT" | "PAID" | "CANCELLED" | "REFUNDED", extra: Record<string, unknown> = {}) =>
    db.order.create({ data: { sellerId: seller.id, orderNo: ++orderNo, buyerMemberId, broadcastNicknameSnapshot: "닉", totalAmount: 1000, status, ...extra } });
  return { seller, grade, buyer, other, make, scope: { sellerId: seller.id, buyerMemberId: buyer.id } };
}

describe("구매자 주문 목록 기간·탭", () => {
  it("기간 없이 부르면 기본은 최근 3개월(오늘 KST ~ 석 달 전 같은 날), range에 돌려주고, from·to로 바꾼다. 자정 직후(KST)에도 같다", async () => {
    const s = await setup();
    const now = new Date("2026-10-05T15:10:00Z"); // KST 2026-10-06 00:10
    const recent = await s.make(s.buyer.id, "PAID", { createdAt: new Date(now.getTime() - 10 * DAY) });
    const old = await s.make(s.buyer.id, "PAID", { createdAt: new Date(now.getTime() - 40 * DAY) });
    const older = await s.make(s.buyer.id, "PAID", { createdAt: new Date(now.getTime() - 100 * DAY) });
    const r = await listBuyerOrders(db, s.scope, { now });
    expect(r.ok && r.value.range).toEqual({ from: "2026-07-06", to: "2026-10-06" });
    // 40일 전은 3개월 안, 100일 전은 밖
    expect(r.ok && r.value.orders.map((o) => o.id)).toEqual([recent.id, old.id]);
    expect(r.ok && r.value.counts.all).toBe(2);
    expect(older.id).not.toBe(old.id);
    const wide = await listBuyerOrders(db, s.scope, { from: "2026-06-01", to: "2026-10-06", now });
    expect(wide.ok && wide.value.orders.map((o) => o.id)).toEqual([recent.id, old.id, older.id]);
    // to 날짜 하루 전체가 들어간다(KST 23:59 주문)
    const lateKst = await s.make(s.buyer.id, "PAID", { createdAt: new Date("2026-10-01T14:59:00Z") });
    const day = await listBuyerOrders(db, s.scope, { from: "2026-10-01", to: "2026-10-01", now });
    expect(day.ok && day.value.orders.map((o) => o.id)).toEqual([lateKst.id]);
  });

  it("기간·탭 값이 이상하면 거부한다(날짜 형식·from > to·1년 초과·모르는 탭)", async () => {
    const s = await setup();
    for (const bad of [{ from: "2026-13-01" }, { to: "abc" }, { from: "2026-10-05", to: "2026-10-01" }, { from: "2024-01-01", to: "2026-01-01" }, { from: 5 }]) {
      expect(await listBuyerOrders(db, s.scope, bad)).toMatchObject({ ok: false, reason: "invalid_range" });
    }
    expect(await listBuyerOrders(db, s.scope, { tab: "weird" })).toMatchObject({ ok: false, reason: "invalid_tab" });
    expect(await listBuyerOrders(db, s.scope, { tab: 3 })).toMatchObject({ ok: false, reason: "invalid_tab" });
  });

  it("탭 6개: 결제 대기·진행 중·완료(배송 완료 또는 구매 확정)·취소·환불, counts는 같은 기간의 탭별 전체 개수(탭·커서와 무관, 다른 구매자 주문 제외)", async () => {
    const s = await setup();
    const now = new Date();
    const pending = await s.make(s.buyer.id, "PENDING_PAYMENT");
    const progress = await s.make(s.buyer.id, "PAID");
    const shipping = await s.make(s.buyer.id, "PAID");
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: shipping.id, courier: "CJ", trackingNumber: "1", status: "IN_TRANSIT", shippedAt: now } });
    const delivered = await s.make(s.buyer.id, "PAID");
    await db.shipment.create({ data: { sellerId: s.seller.id, orderId: delivered.id, courier: "CJ", trackingNumber: "2", status: "DELIVERED", shippedAt: now, deliveredAt: now } });
    const confirmed = await s.make(s.buyer.id, "PAID", { purchaseConfirmedAt: now });
    const cancelled = await s.make(s.buyer.id, "CANCELLED");
    const refunded = await s.make(s.buyer.id, "REFUNDED");
    await s.make(s.other.id, "PAID");
    const ids = async (tab: string, extra: object = {}) => {
      const r = await listBuyerOrders(db, s.scope, { tab, ...extra });
      return r.ok ? r.value.orders.map((o) => o.id).sort() : r;
    };
    expect(await ids("pending")).toEqual([pending.id]);
    expect(await ids("inProgress")).toEqual([progress.id, shipping.id].sort());
    expect(await ids("done")).toEqual([delivered.id, confirmed.id].sort());
    expect(await ids("cancelled")).toEqual([cancelled.id]);
    expect(await ids("refunded")).toEqual([refunded.id]);
    expect((await ids("all")) as string[]).toHaveLength(7);
    const expected = { all: 7, pending: 1, inProgress: 2, done: 2, cancelled: 1, refunded: 1 };
    for (const tab of ["all", "pending", "done"]) {
      const r = await listBuyerOrders(db, s.scope, { tab, limit: 1 });
      expect(r.ok && r.value.counts).toEqual(expected);
    }
    // 페이지를 넘겨도(커서) 개수는 그대로, 탭 안에서 이어진다
    const first = await listBuyerOrders(db, s.scope, { tab: "inProgress", limit: 1 });
    expect(first.ok && first.value.nextCursor).not.toBeNull();
    const second = await listBuyerOrders(db, s.scope, { tab: "inProgress", limit: 1, cursor: first.ok ? first.value.nextCursor : undefined });
    expect(second.ok && second.value.orders).toHaveLength(1);
    expect(second.ok && second.value.counts).toEqual(expected);
  });
});

describe("구매자 주문 목록 사진·개봉 상태", () => {
  it("주문 품목에 사진 주소·옵션 id가 붙고, 개봉 대기 주문은 앞 대기 수와 함께 queue로 나온다(개봉 중·완료·대기열 없음 포함)", async () => {
    const s = await setup();
    const product = await db.product.create({ data: { sellerId: s.seller.id, name: "팩", price: 5000, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: s.seller.id, productId: product.id, name: "1개", stock: 50 } });
    await db.productImage.create({
      data: { sellerId: s.seller.id, productId: product.id, storageKey: `k-${product.id}`, contentType: "image/jpeg", byteSize: 10, width: 10, height: 10, sha256: "a".repeat(64), kind: "GALLERY" },
    });
    const place = async (buyerId: string, pay = true) => {
      const o = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: buyerId, items: [{ optionId: option.id, quantity: 1 }], consent, shippingAddress: addr });
      if (!o.ok) throw new Error(o.reason);
      if (pay) await markOrderPaid(db, { sellerId: s.seller.id, orderId: o.orderId, paymentMethod: "CARD" });
      return o.orderId;
    };
    const first = await place(s.other.id); // 다른 구매자가 앞
    const mine = await place(s.buyer.id);
    const unpaid = await place(s.buyer.id, false);
    const r = await listBuyerOrders(db, s.scope, {});
    if (!r.ok) throw new Error(r.reason);
    const byId = new Map(r.value.orders.map((o) => [o.id, o]));
    const m = byId.get(mine)!;
    expect(m.items[0]).toMatchObject({ productId: product.id, optionId: option.id });
    expect(m.items[0].imageUrl).toMatch(new RegExp(`^/api/shop/${s.seller.slug}/`));
    expect(m.items[0].queue).toMatchObject({ status: "WAITING", waitingNumber: 2 });
    expect(m.queue).toEqual({ status: "WAITING", aheadCount: 1 });
    expect(byId.get(unpaid)!.queue).toBeNull();
    // 다른 구매자의 주문·닉네임은 응답에 없다
    expect(JSON.stringify(r.value)).not.toContain(first);
    // 개봉 중 → OPENING, 끝나면 DONE
    const q = await db.queueItem.findFirstOrThrow({ where: { orderId: mine } });
    await db.queueItem.update({ where: { id: q.id }, data: { status: "OPENING", openingStartedAt: new Date() } });
    const opening = await listBuyerOrders(db, s.scope, {});
    expect(opening.ok && opening.value.orders.find((o) => o.id === mine)?.queue).toEqual({ status: "OPENING", aheadCount: 0 });
    await db.queueItem.update({ where: { id: q.id }, data: { status: "DONE", doneAt: new Date() } });
    const done = await listBuyerOrders(db, s.scope, {});
    expect(done.ok && done.value.orders.find((o) => o.id === mine)?.queue).toEqual({ status: "DONE", aheadCount: 0 });
  });
});
