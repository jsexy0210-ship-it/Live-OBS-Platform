import type { PrismaClient, RefundFault } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { PAID_CANCEL_LIMIT, RESTRICTION_DAYS, UNPAID_CANCEL_LIMIT, cancelOverdueOrders, liftRestriction, lockSellerOrders, readOrderPolicy, sellerEventClock, updateOrderPolicy } from "../../lib/server/orders/overdue";
import { refundOrder } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createLoginBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => db.$disconnect());

const BASE = { autoCancelEnabled: true, paymentDueHours: 24, unpaidRestrictionEnabled: true };
const addr = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const lv = async () => (await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).liveVersion;
  // 결제 완료 주문을 만들고 바로 환불한다(발송 전)
  const refund = async (fault?: RefundFault) => {
    const { order } = await createPaidOrderItem(seller.id, buyer.id);
    const r = await refundOrder(db, ctx, order.id, { reason: "취소 요청", expectedLiveVersion: await lv(), ...(fault ? { fault } : {}) });
    expect(r.ok).toBe(true);
    return order.id;
  };
  const place = async () => {
    const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
    const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 10 } });
    return createOrder(db, {
      sellerId: seller.id,
      buyerMemberId: buyer.id,
      items: [{ optionId: option.id, quantity: 1 }],
      consent: { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version },
      shippingAddress: addr,
    });
  };
  const restrictions = () => db.buyerPurchaseRestriction.findMany({ where: { sellerId: seller.id, buyerMemberId: buyer.id }, orderBy: { startsAt: "asc" } });
  return { seller, ctx, buyer, refund, place, restrictions };
}

describe("결제 후 취소 5회 → 30일 구매 제한", () => {
  it("기본은 꺼져 있어 환불이 쌓여도 제한하지 않는다", async () => {
    const s = await shop();
    expect((await readOrderPolicy(db, s.ctx)).paidCancelRestrictionEnabled).toBe(false);
    for (let i = 0; i < PAID_CANCEL_LIMIT + 1; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toEqual([]);
    expect((await s.place()).ok).toBe(true);
  });

  it("켜면 그 뒤 구매자 사정 환불 5회째에 30일 제한을 걸고, 켜기 전 환불·판매자 사정·미지정 환불은 세지 않는다", async () => {
    const s = await shop();
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund("BUYER");
    expect(await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true })).toMatchObject({ ok: true, policy: { paidCancelRestrictionEnabled: true } });
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund("SELLER");
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund();
    for (let i = 0; i < PAID_CANCEL_LIMIT - 1; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toEqual([]);
    const last = await s.refund("BUYER");
    const [r] = await s.restrictions();
    expect(r).toMatchObject({ reason: "PAID_CANCEL", liftedAt: null });
    expect(r.endsAt.getTime() - r.startsAt.getTime()).toBe(RESTRICTION_DAYS * 24 * 60 * 60 * 1000);
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.purchase_restriction.create", targetId: s.buyer.id } })).toMatchObject({
      actorType: "SYSTEM",
      after: { reason: "PAID_CANCEL", paidCancels: PAID_CANCEL_LIMIT },
    });
    // 발송 전 환불도 사유 주체를 골라 남길 수 있다
    expect(await db.order.findUniqueOrThrow({ where: { id: last } })).toMatchObject({ status: "REFUNDED", refundFault: "BUYER" });
    // 제한 중 새 주문은 막는다
    expect(await s.place()).toMatchObject({ ok: false, reason: "purchase_restricted", endsAt: r.endsAt });
    // 꺼도 이미 걸린 제한은 그대로 둔다
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: false });
    expect(await s.place()).toMatchObject({ ok: false, reason: "purchase_restricted" });
  });

  it("판매자가 풀면 그 뒤 환불만 다시 센다", async () => {
    const s = await shop();
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(1);
    expect(await liftRestriction(db, s.ctx, s.buyer.id)).toMatchObject({ ok: true });
    expect((await s.restrictions())[0].liftedAt).not.toBeNull();
    for (let i = 0; i < PAID_CANCEL_LIMIT - 1; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(1);
    await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(2);
  });

  it("설정: 빼고 보내면 지금 값을 유지하고, 불리언이 아니면 400, 껐다 켜면 켠 뒤 환불만 센다", async () => {
    const s = await shop();
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    expect(await updateOrderPolicy(db, s.ctx, BASE)).toMatchObject({ ok: true, policy: { paidCancelRestrictionEnabled: true } });
    expect(await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: "yes" })).toEqual({ ok: false, reason: "invalid_order_policy" });
    for (let i = 0; i < PAID_CANCEL_LIMIT - 1; i++) await s.refund("BUYER");
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: false });
    await s.refund("BUYER");
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    for (let i = 0; i < PAID_CANCEL_LIMIT - 1; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toEqual([]);
    await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(1);
  });
  it("같은 옵션으로 주문 생성과 그 옵션 주문 환불이 동시에 와도 교착 없이 둘 다 끝난다", async () => {
    const s = await shop();
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    const product = await db.product.create({ data: { sellerId: s.seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE", stockDeductMode: "ORDER" } });
    const option = await db.productOption.create({ data: { sellerId: s.seller.id, productId: product.id, name: "1박스", stock: 10 } });
    const input = {
      sellerId: s.seller.id,
      buyerMemberId: s.buyer.id,
      items: [{ optionId: option.id, quantity: 1 }],
      consent: { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version },
      shippingAddress: addr,
    };
    // 주문할 때 재고를 뺀 결제 완료 주문(환불하면 같은 옵션 재고를 되돌린다)
    const first = await createOrder(db, input);
    if (!first.ok) throw new Error(first.reason);
    await db.order.update({ where: { id: first.orderId }, data: { status: "PAID", paidAt: new Date() } });
    const lv = (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion;
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    // 주문 생성이 주문 번호 잠금을 잡은 직후 멈춘 사이 환불을 보낸다
    const paused = new Proxy(db, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (p === "$transaction") {
          return (fn: (tx: object) => unknown, o?: unknown) =>
            t.$transaction((tx) => {
              let first = true;
              const wrapped = new Proxy(tx, {
                get(x, k, r) {
                  const f = Reflect.get(x, k, r);
                  if (k !== "$queryRaw" || !first) return f;
                  return async (...a: unknown[]) => {
                    first = false;
                    await gate;
                    return (f as (...b: unknown[]) => unknown).apply(x, a);
                  };
                },
              });
              return fn(wrapped) as Promise<unknown>;
            }, o as never);
        }
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as PrismaClient;
    const ordering = createOrder(paused, input);
    await new Promise((r) => setTimeout(r, 200));
    const refunding = refundOrder(db, s.ctx, first.orderId, { reason: "취소 요청", expectedLiveVersion: lv, fault: "BUYER" });
    await new Promise((r) => setTimeout(r, 500));
    release(null);
    const [ordered, refunded] = await Promise.all([ordering, refunding]);
    expect(ordered.ok).toBe(true);
    expect(refunded.ok).toBe(true);
    // 처음 10 − 주문 2 + 환불 1
    expect((await db.productOption.findUniqueOrThrow({ where: { id: option.id } })).stock).toBe(9);
  });
  it("설정을 켜는 사이 시작된 환불도 켠 뒤 시각으로 기록되어 횟수에 들어간다", async () => {
    const s = await shop();
    const { order } = await createPaidOrderItem(s.seller.id, s.buyer.id);
    const lv = (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion;
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    let refunding!: ReturnType<typeof refundOrder>;
    // 주문 생성 잠금을 쥔 채 설정을 켜는 동안, 먼저 시작한 환불은 잠금을 기다린다
    const enabling = db.$transaction(async (tx) => {
      await lockSellerOrders(tx, s.seller.id);
      refunding = refundOrder(db, s.ctx, order.id, { reason: "취소 요청", expectedLiveVersion: lv, fault: "BUYER" });
      await new Promise((r) => setTimeout(r, 300));
      // 실제 켜기 경로(updateOrderPolicy)와 같이 판매자 시계로 켠 시각을 찍는다(lastEventClockAt도 같은 값)
      const at = await sellerEventClock(tx, s.seller.id);
      await tx.sellerOrderPolicy.update({ where: { sellerId: s.seller.id }, data: { paidCancelRestrictionEnabled: true, paidCancelRestrictionEnabledAt: at } });
      release(null);
    });
    await gate;
    await enabling;
    expect((await refunding).ok).toBe(true);
    const policy = await db.sellerOrderPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    const refunded = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(refunded.refundedAt!.getTime()).toBeGreaterThan(policy.paidCancelRestrictionEnabledAt!.getTime());
    // 이 환불을 포함해 5회째에 제한이 걸린다
    for (let i = 0; i < PAID_CANCEL_LIMIT - 2; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toEqual([]);
    await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(1);
  });
  it("다른 제한(미입금)이 걸려 있는 동안 5회째 환불이 와도 새 30일 제한을 만들어, 앞 제한이 끝나도 주문을 막는다", async () => {
    const s = await shop();
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    const unpaid = await db.buyerPurchaseRestriction.create({
      data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, reason: "UNPAID_AUTO_CANCEL", startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund("BUYER");
    const all = await s.restrictions();
    expect(all.map((r) => r.reason)).toEqual(["UNPAID_AUTO_CANCEL", "PAID_CANCEL"]);
    // 미입금 제한이 끝난 뒤에도 결제 후 취소 제한으로 막는다
    await db.buyerPurchaseRestriction.update({ where: { id: unpaid.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    expect(await s.place()).toMatchObject({ ok: false, reason: "purchase_restricted", endsAt: all[1].endsAt });
  });

  it("제한이 겹쳐 있으면 풀기 한 번에 모두 풀어 바로 주문할 수 있다", async () => {
    const s = await shop();
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    await db.buyerPurchaseRestriction.create({
      data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, reason: "UNPAID_AUTO_CANCEL", startsAt: new Date(Date.now() - 1000), endsAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(2);
    expect(await liftRestriction(db, s.ctx, s.buyer.id)).toMatchObject({ ok: true });
    expect((await s.restrictions()).every((r) => r.liftedAt !== null)).toBe(true);
    expect(await db.auditLog.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { action: "buyer.purchase_restriction.lift", targetId: s.buyer.id } })).toMatchObject({ after: { lifted: 2 } });
    expect((await s.place()).ok).toBe(true);
  });
  it("기준 시각(켠 시각)과 같거나 늦은 시계로 들어온 환불도 기준 뒤로 기록되어 횟수에 들어간다", async () => {
    const s = await shop();
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    // 켠 시각(판매자 시계)이 DB 시계와 같은 밀리초(또는 그보다 뒤)인 경우를 강제로 만든다
    const enabledAt = new Date(Date.now() + 2000);
    await db.sellerOrderPolicy.update({ where: { sellerId: s.seller.id }, data: { paidCancelRestrictionEnabledAt: enabledAt, lastEventClockAt: enabledAt } });
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund("BUYER");
    const refunded = await db.order.findMany({ where: { sellerId: s.seller.id, status: "REFUNDED" }, select: { refundedAt: true } });
    expect(refunded.every((o) => o.refundedAt!.getTime() > enabledAt.getTime())).toBe(true);
    expect(await s.restrictions()).toHaveLength(1);
  });

  it("미입금 자동 취소도 기준 시각과 같거나 늦은 시계로 들어오면 기준 뒤로 기록되어 횟수에 들어간다", async () => {
    const s = await shop();
    const enabledAt = new Date(Date.now() + 2000);
    await db.sellerOrderPolicy.create({ data: { sellerId: s.seller.id, unpaidRestrictionEnabledAt: enabledAt, lastEventClockAt: enabledAt } });
    for (let i = 0; i < UNPAID_CANCEL_LIMIT; i++) {
      await db.order.create({
        data: { sellerId: s.seller.id, orderNo: 9000 + i, buyerMemberId: s.buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 1000, status: "PENDING_PAYMENT", paymentDueAt: new Date(Date.now() - 60_000) },
      });
    }
    const r = await cancelOverdueOrders(db);
    expect(r.cancelled).toHaveLength(UNPAID_CANCEL_LIMIT);
    const cancelled = await db.order.findMany({ where: { sellerId: s.seller.id, status: "CANCELLED" }, select: { autoCancelledAt: true } });
    expect(cancelled.every((o) => o.autoCancelledAt!.getTime() > enabledAt.getTime())).toBe(true);
    expect((await s.restrictions()).map((x) => x.reason)).toEqual(["UNPAID_AUTO_CANCEL"]);
  });
  it("꺼져 있을 때 생긴 환불은 기준과 같은 밀리초에 켜더라도 세지 않는다(꺼진 동안에는 시각을 보정하지 않음)", async () => {
    const s = await shop();
    // 꺼진 상태에서 마지막 제한을 푼 시각(판매자 시계)이 DB 시계와 같거나 뒤인 경우를 강제로 만든다
    const liftedAt = new Date(Date.now() + 2000);
    await db.buyerPurchaseRestriction.create({
      data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, reason: "UNPAID_AUTO_CANCEL", startsAt: new Date(Date.now() - 60_000), endsAt: new Date(Date.now() + 60_000), liftedAt },
    });
    await db.sellerOrderPolicy.create({ data: { sellerId: s.seller.id, lastEventClockAt: liftedAt } });
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund("BUYER");
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    // 켠 뒤 환불 1건: 꺼진 동안 5건을 함께 세면 제한이 걸린다
    await s.refund("BUYER");
    expect((await s.restrictions()).filter((r) => r.reason === "PAID_CANCEL")).toEqual([]);
  });

  it("켤 때 기준 시각은 그 판매자의 마지막 사건 시각보다 앞서지 않아, 켜기 전 사건은 세지 않고 켠 뒤 사건만 센다", async () => {
    const s = await shop();
    // 켜기 전 환불이 DB 시계보다 뒤 시각으로 남은 경우(예: 앞선 보정)를 강제로 만든다
    const { order } = await createPaidOrderItem(s.seller.id, s.buyer.id);
    const late = new Date(Date.now() + 2000);
    await db.order.update({ where: { id: order.id }, data: { status: "REFUNDED", refundedAt: late, refundFault: "BUYER" } });
    await db.sellerOrderPolicy.create({ data: { sellerId: s.seller.id, lastEventClockAt: late } });
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    const policy = await db.sellerOrderPolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    expect(policy.paidCancelRestrictionEnabledAt!.getTime()).toBeGreaterThanOrEqual(late.getTime());
    for (let i = 0; i < PAID_CANCEL_LIMIT - 1; i++) await s.refund("BUYER");
    expect(await s.restrictions()).toEqual([]);
    await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(1);
  });
  it("같은 밀리초에 몰린 환불로 제한이 걸린 뒤 바로 풀어도, 푼 시각이 그 사건들 뒤라 다음 환불 1회로 다시 걸리지 않는다", async () => {
    const s = await shop();
    await updateOrderPolicy(db, s.ctx, { ...BASE, paidCancelRestrictionEnabled: true });
    for (let i = 0; i < PAID_CANCEL_LIMIT; i++) await s.refund("BUYER");
    const [r] = await s.restrictions();
    // 환불·제한 시각이 DB 시계보다 뒤(같은 밀리초로 밀린 경우)인 상태를 강제로 만든다
    const late = new Date(Date.now() + 2000);
    await db.order.updateMany({ where: { sellerId: s.seller.id, status: "REFUNDED" }, data: { refundedAt: late } });
    await db.buyerPurchaseRestriction.update({ where: { id: r.id }, data: { startsAt: late } });
    await db.sellerOrderPolicy.update({ where: { sellerId: s.seller.id }, data: { lastEventClockAt: late } });
    expect(await liftRestriction(db, s.ctx, s.buyer.id)).toMatchObject({ ok: true });
    const lifted = await db.buyerPurchaseRestriction.findUniqueOrThrow({ where: { id: r.id } });
    expect(lifted.liftedAt!.getTime()).toBeGreaterThan(late.getTime());
    await s.refund("BUYER");
    expect(await s.restrictions()).toHaveLength(1);
  });
});
