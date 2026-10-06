import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { shipOrder } from "../../lib/server/orders/ship";
import { TRACKING_INTERVAL_MS, runDeliveryTrackingLookups } from "../../lib/server/orders/tracking";
import { FakeDeliveryTrackingProvider, deliveryTrackingProvider } from "../../lib/server/orders/trackingProvider";
import { markOrderPaid } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 배송 자동조회(autoTrackingEnabled): 켠 경우에만 조회하고 건당 발송·이용 충전금을 차감한다. 잔액이 없으면 조회만 멈추고 주문·배송은 그대로(docs/COST_POLICY.md).
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };
const PRICE = 30;
let seq = 0;

async function shop(opts: { tracking?: boolean; charging?: boolean; paid?: number; free?: number } = {}) {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 500 } });
  await db.sellerOrderPolicy.upsert({ where: { sellerId: seller.id }, create: { sellerId: seller.id, autoTrackingEnabled: opts.tracking ?? true }, update: { autoTrackingEnabled: opts.tracking ?? true } });
  await db.platformMessageSetting.upsert({ where: { id: 1 }, create: { id: 1, chargingEnabled: opts.charging ?? true }, update: { chargingEnabled: opts.charging ?? true } });
  await db.messageChannelPrice.upsert({ where: { channel: "DELIVERY_TRACKING" }, create: { channel: "DELIVERY_TRACKING", unitPrice: PRICE }, update: { unitPrice: PRICE } });
  await db.sellerMessageBalance.create({ data: { sellerId: seller.id, paidBalance: opts.paid ?? 1000, freeBalance: opts.free ?? 0 } });
  const shipped = async () => {
    const r = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity: 1 }], consent, shippingAddress: addr });
    if (!r.ok) throw new Error(r.reason);
    await markOrderPaid(db, { sellerId: seller.id, orderId: r.orderId, paymentMethod: "CARD" });
    const trackingNumber = `T${String(++seq).padStart(11, "0")}`;
    const s = await shipOrder(db, ctx, r.orderId, { courier: "CJ", trackingNumber });
    if (!s.ok) throw new Error(s.reason);
    return { orderId: r.orderId, trackingNumber };
  };
  return { seller, buyer, ctx, shipped };
}

const balance = async (sellerId: string) => {
  const b = await db.sellerMessageBalance.findUniqueOrThrow({ where: { sellerId } });
  return { paid: b.paidBalance, free: b.freeBalance };
};
const debits = (sellerId: string) => db.sellerMessageLedger.findMany({ where: { sellerId, type: "DEBIT", channel: "DELIVERY_TRACKING" }, orderBy: { createdAt: "asc" } });
const shipment = (orderId: string) => db.shipment.findUniqueOrThrow({ where: { orderId } });
const NOW = () => new Date(Date.now() + 60_000);

describe("배송 자동조회 충전금 차감", () => {
  it("실제 조회 업체가 연결되기 전에는 공급자가 없어 조회도 차감도 하지 않는다", async () => {
    expect(deliveryTrackingProvider()).toBeNull();
    const s = await shop();
    await s.shipped();
    expect(await runDeliveryTrackingLookups(db, null)).toEqual({ looked: 0, delivered: 0, skippedNoBalance: 0, skippedChargingOff: 0, failed: 0 });
    expect(await balance(s.seller.id)).toEqual({ paid: 1000, free: 0 });
  });

  it("끄면(기본) 조회도 차감도 없다: 무료, 택배사 조회 링크가 기본", async () => {
    const s = await shop({ tracking: false });
    const o = await s.shipped();
    const p = new FakeDeliveryTrackingProvider();
    expect(await runDeliveryTrackingLookups(db, p, { now: NOW() })).toMatchObject({ looked: 0, failed: 0 });
    expect(p.calls).toEqual([]);
    expect(await debits(s.seller.id)).toEqual([]);
    expect((await shipment(o.orderId)).trackingCheckedAt).toBeNull();
  });

  it("켠 판매자만 조회하고 건당 단가를 차감한다(유료 잔액 먼저, 모자라면 무상). 차감은 확정(SUCCEEDED)", async () => {
    const s = await shop({ paid: 20, free: 100 });
    const o = await s.shipped();
    const p = new FakeDeliveryTrackingProvider();
    expect(await runDeliveryTrackingLookups(db, p, { now: NOW() })).toMatchObject({ looked: 1, delivered: 0, failed: 0 });
    expect(p.calls).toEqual([{ courier: "CJ", trackingNumber: o.trackingNumber }]);
    const [d] = await debits(s.seller.id);
    expect(d).toMatchObject({ status: "SUCCEEDED", paidAmount: -20, freeAmount: -10, unitPrice: PRICE, quantity: 1 });
    expect(await balance(s.seller.id)).toEqual({ paid: 0, free: 90 });
    expect((await shipment(o.orderId)).status).toBe("IN_TRANSIT");
  });

  it("같은 조회 구간에는 여러 번·동시에 돌려도 조회·차감은 한 번이고, 다음 구간에 다시 조회한다", async () => {
    const s = await shop();
    await s.shipped();
    const p = new FakeDeliveryTrackingProvider();
    const t = NOW();
    const rs = await Promise.all([runDeliveryTrackingLookups(db, p, { now: t }), runDeliveryTrackingLookups(db, p, { now: t })]);
    expect(rs.reduce((n, r) => n + r.looked, 0)).toBe(1);
    await runDeliveryTrackingLookups(db, p, { now: t });
    expect(p.calls).toHaveLength(1);
    expect(await debits(s.seller.id)).toHaveLength(1);
    expect(await balance(s.seller.id)).toEqual({ paid: 1000 - PRICE, free: 0 });
    await runDeliveryTrackingLookups(db, p, { now: new Date(t.getTime() + TRACKING_INTERVAL_MS + 1000) });
    expect(p.calls).toHaveLength(2);
    expect(await debits(s.seller.id)).toHaveLength(2);
    expect(await balance(s.seller.id)).toEqual({ paid: 1000 - 2 * PRICE, free: 0 });
  });

  it("잔액이 없으면 조회만 멈추고 주문·배송은 그대로이며, 충전하면 다음 구간에 이어진다", async () => {
    const s = await shop({ paid: 10, free: 0 }); // 단가 30원보다 적음
    const o = await s.shipped();
    const p = new FakeDeliveryTrackingProvider();
    const t = NOW();
    expect(await runDeliveryTrackingLookups(db, p, { now: t })).toMatchObject({ looked: 0, skippedNoBalance: 1, failed: 0 });
    expect(p.calls).toEqual([]);
    expect(await debits(s.seller.id)).toEqual([]);
    expect(await balance(s.seller.id)).toEqual({ paid: 10, free: 0 });
    expect(await shipment(o.orderId)).toMatchObject({ status: "IN_TRANSIT" });
    expect((await db.order.findUniqueOrThrow({ where: { id: o.orderId } })).status).toBe("PAID");
    await db.sellerMessageBalance.update({ where: { sellerId: s.seller.id }, data: { paidBalance: { increment: 500 } } });
    expect(await runDeliveryTrackingLookups(db, p, { now: new Date(t.getTime() + TRACKING_INTERVAL_MS + 1000) })).toMatchObject({ looked: 1 });
    expect(await balance(s.seller.id)).toEqual({ paid: 510 - PRICE, free: 0 });
  });

  it("충전 기능이 꺼져 있으면 차감하지 않고 조회도 하지 않는다", async () => {
    const s = await shop({ charging: false });
    await s.shipped();
    const p = new FakeDeliveryTrackingProvider();
    expect(await runDeliveryTrackingLookups(db, p, { now: NOW() })).toMatchObject({ looked: 0, skippedChargingOff: 1 });
    expect(p.calls).toEqual([]);
    expect(await balance(s.seller.id)).toEqual({ paid: 1000, free: 0 });
  });

  it("조회가 실패하면(오류 응답·예외·시간 초과) 차감을 되돌린다", async () => {
    const s = await shop();
    await s.shipped();
    const p = new FakeDeliveryTrackingProvider();
    const t = NOW();
    p.failNext = "error";
    expect(await runDeliveryTrackingLookups(db, p, { now: t })).toMatchObject({ looked: 0, failed: 1 });
    expect(await balance(s.seller.id)).toEqual({ paid: 1000, free: 0 });
    expect((await debits(s.seller.id)).map((d) => d.status)).toEqual(["REVERSED"]);
    p.failNext = "throw";
    expect(await runDeliveryTrackingLookups(db, p, { now: new Date(t.getTime() + TRACKING_INTERVAL_MS + 1000) })).toMatchObject({ failed: 1 });
    expect(await balance(s.seller.id)).toEqual({ paid: 1000, free: 0 });
    const slow = { name: "slow", lookup: () => new Promise<never>(() => undefined) };
    expect(await runDeliveryTrackingLookups(db, slow, { now: new Date(t.getTime() + 2 * TRACKING_INTERVAL_MS + 2000), timeoutMs: 50 })).toMatchObject({ failed: 1 });
    expect(await balance(s.seller.id)).toEqual({ paid: 1000, free: 0 });
    expect((await debits(s.seller.id)).every((d) => d.status === "REVERSED")).toBe(true);
  });

  it("택배사가 배송 완료로 알려 주면 판매자 직접 처리와 같은 경로로 배송 완료가 되고 이 건은 차감된다", async () => {
    const s = await shop();
    const a = await s.shipped();
    const b = await s.shipped();
    const p = new FakeDeliveryTrackingProvider();
    p.results.set(a.trackingNumber, { ok: true, status: "DELIVERED" });
    expect(await runDeliveryTrackingLookups(db, p, { now: NOW() })).toMatchObject({ looked: 2, delivered: 1 });
    expect(await shipment(a.orderId)).toMatchObject({ status: "DELIVERED", deliveredAt: expect.any(Date) });
    expect((await shipment(b.orderId)).status).toBe("IN_TRANSIT");
    expect(await db.auditLog.count({ where: { action: "order.carrier_deliver", targetId: a.orderId } })).toBe(1);
    expect(await balance(s.seller.id)).toEqual({ paid: 1000 - 2 * PRICE, free: 0 });
    // 배송 완료된 건은 더 조회하지 않는다
    const p2 = new FakeDeliveryTrackingProvider();
    await runDeliveryTrackingLookups(db, p2, { now: new Date(Date.now() + 2 * TRACKING_INTERVAL_MS) });
    expect(p2.calls.map((c) => c.trackingNumber)).toEqual([b.trackingNumber]);
  });

  it("차감만 잡힌 채 멈춘 시도는 같은 차감으로 이어서 조회하고 두 번 차감하지 않는다", async () => {
    const s = await shop();
    const o = await s.shipped();
    const t = NOW();
    const sh = await shipment(o.orderId);
    const slot = Math.floor(t.getTime() / TRACKING_INTERVAL_MS);
    // 멈춘 시도: 차감을 잡았고(PENDING) 조회는 못 했다
    const { reserveDebit } = await import("../../lib/server/messaging/balance");
    const r = await db.$transaction((tx) => reserveDebit(tx, { sellerId: s.seller.id, channel: "DELIVERY_TRACKING", idempotencyKey: `tracking:${sh.id}:${slot}`, now: t }));
    expect(r.ok).toBe(true);
    expect(await balance(s.seller.id)).toEqual({ paid: 1000 - PRICE, free: 0 });
    const p = new FakeDeliveryTrackingProvider();
    expect(await runDeliveryTrackingLookups(db, p, { now: t })).toMatchObject({ looked: 1 });
    expect(p.calls).toHaveLength(1);
    expect(await debits(s.seller.id)).toHaveLength(1);
    expect((await debits(s.seller.id))[0].status).toBe("SUCCEEDED");
    expect(await balance(s.seller.id)).toEqual({ paid: 1000 - PRICE, free: 0 });
  });

  it("선점 뒤에 판매자가 끄면 차감하지 않는다", async () => {
    const s = await shop();
    await s.shipped();
    await db.sellerOrderPolicy.update({ where: { sellerId: s.seller.id }, data: { autoTrackingEnabled: false } });
    const p = new FakeDeliveryTrackingProvider();
    expect(await runDeliveryTrackingLookups(db, p, { now: NOW() })).toMatchObject({ looked: 0 });
    expect(await debits(s.seller.id)).toEqual([]);
  });

  it("환불·취소된 주문(결제 완료 아님)은 조회하지 않는다", async () => {
    const s = await shop();
    const o = await s.shipped();
    await db.order.update({ where: { id: o.orderId }, data: { status: "REFUNDED" } });
    const p = new FakeDeliveryTrackingProvider();
    expect(await runDeliveryTrackingLookups(db, p, { now: NOW() })).toMatchObject({ looked: 0 });
    expect(p.calls).toEqual([]);
  });
});
