import type { Prisma } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as deliverRoute } from "../../app/api/seller/orders/[orderId]/deliver/route";
import { GET as orderPolicyGet, PUT as orderPolicyPut } from "../../app/api/seller/order-policy/route";
import { GET as rewardPolicyGet, PUT as rewardPolicyPut } from "../../app/api/seller/reward-policy/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { getBuyerOrder } from "../../lib/server/orders/buyer";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { autoCompleteDeliveries, autoConfirmPurchases, completeDelivery } from "../../lib/server/orders/delivery";
import { ORDER_ERROR_MESSAGES } from "../../lib/server/orders/messages";
import { getOrder } from "../../lib/server/orders/read";
import { shipOrder } from "../../lib/server/orders/ship";
import { markOrderPaid, refundOrder } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };
const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const DAY = 24 * 60 * 60 * 1000;

async function sellerCookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

// 상품 5,000원 × 2 = 10,000원 + 배송비 3,000원. 적립률 카드 1%(적립 100원).
async function shop(earnTiming?: "ON_PAYMENT" | "ON_DELIVERY") {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 50 } });
  await db.rewardPolicy.create({ data: { sellerId: seller.id, rates: { [grade.id]: { card: 1 } }, ...(earnTiming ? { earnTiming } : {}) } });
  const paid = async () => {
    const r = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity: 2 }], consent, shippingAddress: addr });
    if (!r.ok) throw new Error(r.reason);
    await markOrderPaid(db, { sellerId: seller.id, orderId: r.orderId, paymentMethod: "CARD" });
    return r.orderId;
  };
  const shipped = async () => {
    const id = await paid();
    const s = await shipOrder(db, ctx, id, { courier: "CJ", trackingNumber: "123456789012" });
    if (!s.ok) throw new Error(s.reason);
    return id;
  };
  const deliver = async (orderId: string, cookie: string) =>
    deliverRoute(new Request(`http://localhost:3000/api/seller/orders/${orderId}/deliver`, { method: "POST", headers: { ...H, cookie } }), {
      params: Promise.resolve({ orderId }),
    });
  return { seller, grade, buyer, owner, ctx, paid, shipped, deliver };
}

const earns = (orderId: string) => db.rewardLedger.findMany({ where: { orderId, type: "EARN" } });
const lv = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;
// 발송·배송 완료 시각을 과거로 옮긴다(자동 처리 기준 시각 확인용)
const shippedAgo = (orderId: string, ms: number) => db.shipment.update({ where: { orderId }, data: { shippedAt: new Date(Date.now() - ms) } });
const deliveredAgo = (orderId: string, ms: number) => db.shipment.update({ where: { orderId }, data: { deliveredAt: new Date(Date.now() - ms) } });

describe("배송 완료와 적립금 지급 시점", () => {
  it("기본(배송 완료 후 지급)은 결제 때 적립하지 않고, 배송 완료 때 한 번만 지급 대기를 기록한다", async () => {
    const s = await shop();
    const id = await s.shipped();
    expect(await earns(id)).toHaveLength(0);
    const cookie = await sellerCookie(s.owner.email);
    const res = await s.deliver(id, cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ rewardEarned: 100 });
    expect(await db.shipment.findUniqueOrThrow({ where: { orderId: id } })).toMatchObject({ status: "DELIVERED", deliveredAt: expect.any(Date) });
    expect(await earns(id)).toMatchObject([{ amount: 100, status: "PENDING", idempotencyKey: `earn:${id}` }]);
    expect(await db.auditLog.count({ where: { action: "order.deliver", targetId: id } })).toBe(1);
    // 두 번째는 409와 문구, 적립도 한 번만
    const again = await s.deliver(id, cookie);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "not_deliverable", message: ORDER_ERROR_MESSAGES.not_deliverable });
    expect(await earns(id)).toHaveLength(1);
  });

  it("결제 즉시 지급이면 결제 때 기록하고, 배송 완료 때 다시 기록하지 않는다", async () => {
    const s = await shop("ON_PAYMENT");
    const id = await s.shipped();
    expect(await earns(id)).toHaveLength(1);
    expect(await completeDelivery(db, s.ctx, id)).toMatchObject({ ok: true, rewardEarned: 0 });
    expect(await earns(id)).toHaveLength(1);
  });

  it("발송 전·환불된 주문은 배송 완료할 수 없고, 다른 쇼핑몰 주문은 404, 주문·배송 권한 없는 직원은 403", async () => {
    const s = await shop();
    const cookie = await sellerCookie(s.owner.email);
    const notShipped = await s.paid();
    expect((await s.deliver(notShipped, cookie)).status).toBe(409);
    const refunded = await s.shipped();
    expect(await refundOrder(db, s.ctx, refunded, { reason: "요청", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER" })).toMatchObject({ ok: true });
    expect((await s.deliver(refunded, cookie)).status).toBe(409);
    expect(await earns(refunded)).toHaveLength(0);
    const other = await shop();
    const otherId = await other.shipped();
    expect((await s.deliver(otherId, cookie)).status).toBe(404);
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    expect((await s.deliver(await s.shipped(), await sellerCookie(staff.email))).status).toBe(403);
  });

  it("배송 완료 뒤 환불하면 배송 완료 때 기록한 적립금을 회수한다", async () => {
    const s = await shop();
    const id = await s.shipped();
    await completeDelivery(db, s.ctx, id);
    expect(await refundOrder(db, s.ctx, id, { reason: "불량", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER" })).toMatchObject({
      ok: true,
      value: { rewardRevoke: "revoked", refundAmount: 13000 },
    });
    expect((await db.rewardLedger.findMany({ where: { orderId: id }, orderBy: { createdAt: "asc" } })).map((r) => [r.type, r.amount])).toEqual([
      ["EARN", 100],
      ["REVOKE", -100],
    ]);
  });
});

describe("자동 배송 완료·자동 구매 확정", () => {
  it("발송 7일(기본)이 지난 배송 중 주문만 자동 배송 완료하고 적립을 기록한다. 다시 돌려도 같다", async () => {
    const s = await shop();
    const old = await s.shipped();
    const recent = await s.shipped();
    await shippedAgo(old, 7 * DAY + 1000);
    await shippedAgo(recent, 6 * DAY);
    expect(await autoCompleteDeliveries(db)).toEqual({ done: [old], failed: [] });
    expect((await db.shipment.findUniqueOrThrow({ where: { orderId: recent } })).status).toBe("IN_TRANSIT");
    expect(await earns(old)).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: "order.auto_deliver", targetId: old } })).toBe(1);
    expect(await autoCompleteDeliveries(db)).toEqual({ done: [], failed: [] });
  });

  it("판매자 설정을 따른다: 끄면 자동 배송 완료하지 않고, 3일로 바꾸면 3일 뒤 처리한다", async () => {
    const off = await shop();
    const a = await off.shipped();
    await shippedAgo(a, 10 * DAY);
    await db.sellerOrderPolicy.create({ data: { sellerId: off.seller.id, autoDeliverEnabled: false } });
    const three = await shop();
    const b = await three.shipped();
    await shippedAgo(b, 3 * DAY + 1000);
    await db.sellerOrderPolicy.create({ data: { sellerId: three.seller.id, autoDeliverDays: 3 } });
    expect(await autoCompleteDeliveries(db)).toEqual({ done: [b], failed: [] });
  });

  it("배송 완료 7일(기본)이 지난 주문만 구매 확정하고, 환불된 주문·이미 확정한 주문은 건드리지 않는다", async () => {
    const s = await shop();
    const due = await s.shipped();
    const early = await s.shipped();
    const refunded = await s.shipped();
    for (const id of [due, early, refunded]) await completeDelivery(db, s.ctx, id);
    await deliveredAgo(due, 7 * DAY + 1000);
    await deliveredAgo(early, 6 * DAY);
    await deliveredAgo(refunded, 8 * DAY);
    await refundOrder(db, s.ctx, refunded, { reason: "불량", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER" });
    expect(await autoConfirmPurchases(db)).toEqual({ done: [due], failed: [] });
    expect((await db.order.findUniqueOrThrow({ where: { id: due } })).purchaseConfirmedAt).toEqual(expect.any(Date));
    expect((await db.order.findUniqueOrThrow({ where: { id: early } })).purchaseConfirmedAt).toBeNull();
    expect((await db.order.findUniqueOrThrow({ where: { id: refunded } })).purchaseConfirmedAt).toBeNull();
    expect(await db.auditLog.count({ where: { action: "order.purchase_confirmed", targetId: due } })).toBe(1);
    expect(await autoConfirmPurchases(db)).toEqual({ done: [], failed: [] });
  });

  it("자동 구매 확정을 끈 쇼핑몰은 확정하지 않는다", async () => {
    const s = await shop();
    const id = await s.shipped();
    await completeDelivery(db, s.ctx, id);
    await deliveredAgo(id, 30 * DAY);
    await db.sellerOrderPolicy.create({ data: { sellerId: s.seller.id, autoConfirmEnabled: false } });
    expect(await autoConfirmPurchases(db)).toEqual({ done: [], failed: [] });
  });
});

// 후보를 고른 뒤, 첫 주문 트랜잭션이 시작되기 직전에 change를 실행하는 db(판매자가 그사이 설정을 바꾼 상황)
function changeBeforeFirstTransaction(change: () => Promise<unknown>): typeof db {
  let first = true;
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "$transaction") {
        return async (fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
          if (first) {
            first = false;
            await change();
          }
          return target.$transaction(fn);
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("자동 처리: 후보를 고른 뒤 바뀐 설정을 따른다", () => {
  it("자동 배송 완료: 후보를 고른 뒤 설정을 끄거나 기간을 늘리면 처리하지 않는다", async () => {
    for (const change of [{ autoDeliverEnabled: false }, { autoDeliverDays: 14 }]) {
      await resetDb();
      const s = await shop();
      const id = await s.shipped();
      await shippedAgo(id, 8 * DAY);
      const changed = changeBeforeFirstTransaction(() => db.sellerOrderPolicy.create({ data: { sellerId: s.seller.id, ...change } }));
      expect(await autoCompleteDeliveries(changed), JSON.stringify(change)).toEqual({ done: [], failed: [] });
      expect((await db.shipment.findUniqueOrThrow({ where: { orderId: id } })).status).toBe("IN_TRANSIT");
      expect(await earns(id)).toHaveLength(0);
    }
  });

  it("자동 구매 확정: 후보를 고른 뒤 설정을 끄거나 기간을 늘리면 처리하지 않는다", async () => {
    for (const change of [{ autoConfirmEnabled: false }, { autoConfirmDays: 14 }]) {
      await resetDb();
      const s = await shop();
      const id = await s.shipped();
      await completeDelivery(db, s.ctx, id);
      await deliveredAgo(id, 8 * DAY);
      const changed = changeBeforeFirstTransaction(() => db.sellerOrderPolicy.create({ data: { sellerId: s.seller.id, ...change } }));
      expect(await autoConfirmPurchases(changed), JSON.stringify(change)).toEqual({ done: [], failed: [] });
      expect((await db.order.findUniqueOrThrow({ where: { id } })).purchaseConfirmedAt).toBeNull();
    }
  });
});

describe("설정 API", () => {
  it("주문 정책: 자동 배송 완료·구매 확정 기간(1~30일)을 저장하고, 빼고 보내면 지금 값을 유지한다. 범위 밖은 400", async () => {
    const s = await shop();
    const cookie = await sellerCookie(s.owner.email);
    const base = { autoCancelEnabled: true, paymentDueHours: 24, unpaidRestrictionEnabled: true };
    const put = (body: unknown) => orderPolicyPut(new Request("http://localhost:3000/api/seller/order-policy", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));
    expect((await put({ ...base, autoDeliverEnabled: false, autoDeliverDays: 3, autoConfirmDays: 30 })).status).toBe(200);
    expect((await put(base)).status).toBe(200);
    const got = await (await orderPolicyGet(new Request("http://localhost:3000/api/seller/order-policy", { headers: { ...H, cookie } }))).json();
    expect(got.policy).toMatchObject({ autoDeliverEnabled: false, autoDeliverDays: 3, autoConfirmEnabled: true, autoConfirmDays: 30 });
    for (const bad of [{ autoDeliverDays: 0 }, { autoConfirmDays: 31 }, { autoDeliverDays: 1.5 }, { autoConfirmEnabled: "yes" }]) {
      const r = await put({ ...base, ...bad });
      expect(r.status).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_order_policy", message: ORDER_ERROR_MESSAGES.invalid_order_policy });
    }
  });

  it("적립금 지급 시점: 기본은 배송 완료 후, 결제 즉시로 바꿀 수 있고 기록을 남긴다. 잘못된 값은 400, 회원·적립금 권한 없는 직원은 403", async () => {
    const { seller } = await createSeller();
    const owner = await createSellerUser(seller.id, "OWNER");
    const cookie = await sellerCookie(owner.email);
    const get = async (c: string) => rewardPolicyGet(new Request("http://localhost:3000/api/seller/reward-policy", { headers: { ...H, cookie: c } }));
    const put = (c: string, body: unknown) => rewardPolicyPut(new Request("http://localhost:3000/api/seller/reward-policy", { method: "PUT", headers: { ...H, cookie: c }, body: JSON.stringify(body) }));
    expect(await (await get(cookie)).json()).toEqual({ policy: { earnTiming: "ON_DELIVERY" } });
    expect((await put(cookie, { earnTiming: "ON_PAYMENT" })).status).toBe(200);
    expect(await (await get(cookie)).json()).toEqual({ policy: { earnTiming: "ON_PAYMENT" } });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "reward_policy.earn_timing", sellerId: seller.id } })).toMatchObject({
      before: { earnTiming: "ON_DELIVERY" },
      after: { earnTiming: "ON_PAYMENT" },
    });
    const bad = await put(cookie, { earnTiming: "on_payment" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_reward_policy", message: ORDER_ERROR_MESSAGES.invalid_reward_policy });
    const staff = await createSellerUser(seller.id, { permissions: ["ORDER_SHIPPING"] });
    expect((await put(await sellerCookie(staff.email), { earnTiming: "ON_DELIVERY" })).status).toBe(403);
  });
});

describe("주문 조회에 환불·구매 확정 정보", () => {
  it("판매자·구매자 주문 조회에 환불 금액·사유 주체·뺀 반품 배송비와 구매 확정 시각이 들어간다", async () => {
    const s = await shop();
    const id = await s.shipped();
    await refundOrder(db, s.ctx, id, { reason: "단순 변심", expectedLiveVersion: await lv(s.seller.id), fault: "BUYER" });
    const refund = { refundAmount: 7000, refundFault: "BUYER", returnFeeDeducted: 3000, purchaseConfirmedAt: null };
    expect(await getOrder(db, s.ctx, id)).toMatchObject(refund);
    expect(await getBuyerOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, id)).toMatchObject(refund);
  });
});
