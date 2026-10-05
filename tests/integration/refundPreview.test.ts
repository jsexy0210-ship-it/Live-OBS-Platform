import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as refundRoute } from "../../app/api/seller/orders/[orderId]/refund/route";
import { GET as orderRoute } from "../../app/api/seller/orders/[orderId]/route";
import { POST as shipRoute } from "../../app/api/seller/orders/[orderId]/ship/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { markOrderPaid, type RefundPreview } from "../../lib/server/queue/service";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 환불 화면은 주문 상세의 refundPreview(계산만)로 확인 전에 실제 환불액을 보여 준다.
// 미리보기 금액이 실제 환불(refundOrder)과 같은지, 환불을 막는 경우(blocked)도 같은지 확인한다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };

// 두 품목(10,000원 × 1 · 4,000원 × 2) 결제 완료 주문. opened 품목은 개봉 완료로, shipped면 발송 기록을 남긴다
async function setup(opts: { opened: ("A" | "B")[]; shipped: boolean }) {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const owner = await createSellerUser(seller.id, "OWNER");
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터", price: 10000, status: "ON_SALE" } });
  const a = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "박스", stock: 50 } });
  const b = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "팩", priceDelta: -6000, stock: 50 } });
  const o = await createOrder(db, {
    sellerId: seller.id,
    buyerMemberId: buyer.id,
    items: [
      { optionId: a.id, quantity: 1 },
      { optionId: b.id, quantity: 2 },
    ],
    consent,
    shippingAddress: addr,
  });
  if (!o.ok) throw new Error(o.reason);
  await markOrderPaid(db, { sellerId: seller.id, orderId: o.orderId, paymentMethod: "CARD" });
  const items = await db.orderItem.findMany({ where: { orderId: o.orderId } });
  for (const key of opts.opened) {
    const item = items.find((i) => i.optionId === (key === "A" ? a.id : b.id))!;
    await db.queueItem.update({ where: { sellerId_orderItemId: { sellerId: seller.id, orderItemId: item.id } }, data: { status: "DONE", openingStartedAt: new Date(), doneAt: new Date() } });
  }
  if (opts.shipped) {
    await db.shipment.create({ data: { sellerId: seller.id, orderId: o.orderId, courier: "CJ", trackingNumber: "123456789012", shippedAt: new Date() } });
  }
  const login = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
  if (!login.ok) throw new Error(login.reason);
  const order = await db.order.findUniqueOrThrow({ where: { id: o.orderId } });
  return { orderId: o.orderId, cookie: `lo_seller=${login.token}`, order, itemA: items.find((i) => i.optionId === a.id)! };
}

async function detail(orderId: string, cookie: string) {
  const r = await orderRoute(new Request(`http://localhost:3000/api/seller/orders/${orderId}`, { headers: { ...H, cookie } }), { params: Promise.resolve({ orderId }) });
  expect(r.status).toBe(200);
  return (await r.json()) as { queueVersion: number; refundPreview: RefundPreview | null };
}

async function refund(orderId: string, cookie: string, expectedVersion: number, fault: "BUYER" | "SELLER", expectedRefundAmount: unknown) {
  const r = await refundRoute(
    new Request(`http://localhost:3000/api/seller/orders/${orderId}/refund`, {
      method: "POST",
      headers: { ...H, cookie },
      body: JSON.stringify({ reason: "기타", expectedVersion, fault, confirmOpened: true, expectedRefundAmount }),
    }),
    { params: Promise.resolve({ orderId }) },
  );
  return { status: r.status, body: (await r.json()) as { refundAmount?: number; error?: string } };
}

describe("주문 상세의 환불 미리보기", () => {
  it("발송 후 구매자 사정: 개봉한 상품·배송비·반품 배송비를 뺀 금액이 실제 환불액과 같다", async () => {
    const { orderId, cookie, order, itemA } = await setup({ opened: ["A"], shipped: true });
    const d = await detail(orderId, cookie);
    expect(d.refundPreview).not.toBeNull();
    const p = d.refundPreview!;
    expect(p.shipped).toBe(true);
    expect(p.openedItems).toEqual([{ orderItemId: itemA.id, amount: 10000 }]);
    // 돌려줄 상품은 4,000원 × 2. 처음 배송비는 돌려주지 않고 반품 배송비를 뺀다
    expect(p.byFault.BUYER.refundAmount).toBe(8000 - p.byFault.BUYER.returnFeeDeducted);
    expect(p.byFault.BUYER.returnFeeDeducted).toBeGreaterThan(0);
    expect(p.byFault.SELLER).toEqual({ refundAmount: order.totalAmount, returnFeeDeducted: 0, rewardReturn: 0, blocked: false });
    const r = await refund(orderId, cookie, d.queueVersion, "BUYER", p.byFault.BUYER.refundAmount);
    expect(r.status).toBe(200);
    expect(r.body.refundAmount).toBe(p.byFault.BUYER.refundAmount);
    // 환불한 주문은 미리보기가 없다
    expect((await detail(orderId, cookie)).refundPreview).toBeNull();
  });

  it("발송 후 판매자 사정: 개봉한 상품까지 모두 돌려주는 금액이 실제 환불액과 같다", async () => {
    const { orderId, cookie } = await setup({ opened: ["A"], shipped: true });
    const d = await detail(orderId, cookie);
    const r = await refund(orderId, cookie, d.queueVersion, "SELLER", d.refundPreview!.byFault.SELLER.refundAmount);
    expect(r.status).toBe(200);
    expect(r.body.refundAmount).toBe(d.refundPreview!.byFault.SELLER.refundAmount);
  });

  it("모든 상품을 개봉했으면 구매자 사정 환불액은 0원이다", async () => {
    const { orderId, cookie } = await setup({ opened: ["A", "B"], shipped: true });
    const p = (await detail(orderId, cookie)).refundPreview!;
    expect(p.byFault.BUYER).toEqual({ refundAmount: 0, returnFeeDeducted: 0, rewardReturn: 0, blocked: false });
    expect(p.openedItems).toHaveLength(2);
  });

  it("발송 전 개봉한 상품이 있으면 구매자 사정은 막히고(blocked) 실제 환불도 막힌다", async () => {
    const { orderId, cookie } = await setup({ opened: ["B"], shipped: false });
    const d = await detail(orderId, cookie);
    expect(d.refundPreview!.byFault.BUYER.blocked).toBe(true);
    expect(d.refundPreview!.byFault.SELLER.blocked).toBe(false);
    const r = await refund(orderId, cookie, d.queueVersion, "BUYER", d.refundPreview!.byFault.BUYER.refundAmount);
    expect(r.body.error).toBe("opened_items_unshipped");
  });
});

describe("확인받은 환불액(expectedRefundAmount)", () => {
  it("서버 계산과 다르면 409 refund_amount_changed이고 주문·주문대기·버전은 그대로다", async () => {
    const { orderId, cookie } = await setup({ opened: ["A"], shipped: true });
    const d = await detail(orderId, cookie);
    const before = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { queueItems: true } });
    const seller = await db.seller.findUniqueOrThrow({ where: { id: before.sellerId }, select: { liveVersion: true } });
    // 화면은 판매자 사정 금액을 확인했는데 그사이 바뀌었다고 가정(구매자 사정으로 보냄)
    const r = await refund(orderId, cookie, d.queueVersion, "BUYER", d.refundPreview!.byFault.SELLER.refundAmount);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("refund_amount_changed");
    const after = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { queueItems: true } });
    expect(after.status).toBe("PAID");
    expect(after.refundAmount).toBeNull();
    expect(after.queueItems.map((q) => q.status).sort()).toEqual(before.queueItems.map((q) => q.status).sort());
    expect((await db.seller.findUniqueOrThrow({ where: { id: before.sellerId }, select: { liveVersion: true } })).liveVersion).toBe(seller.liveVersion);
    expect(await db.orderStatusHistory.count({ where: { orderId, toStatus: "REFUNDED" } })).toBe(0);
    // 같은 버전·맞는 금액이면 그대로 환불된다
    const ok = await refund(orderId, cookie, d.queueVersion, "BUYER", d.refundPreview!.byFault.BUYER.refundAmount);
    expect(ok.status).toBe(200);
    expect(ok.body.refundAmount).toBe(d.refundPreview!.byFault.BUYER.refundAmount);
  });

  it("미리보기 → 다른 화면에서 송장 등록(주문대기 버전 그대로) → 예전 금액으로 환불하면 409이고 아무것도 바뀌지 않는다", async () => {
    const { orderId, cookie } = await setup({ opened: [], shipped: false });
    const d = await detail(orderId, cookie);
    const oldAmount = d.refundPreview!.byFault.BUYER.refundAmount;
    const ship = await shipRoute(
      new Request(`http://localhost:3000/api/seller/orders/${orderId}/ship`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ courier: "CJ", trackingNumber: "123456789012" }) }),
      { params: Promise.resolve({ orderId }) },
    );
    expect(ship.status).toBe(200);
    // 송장 등록은 주문대기 버전을 올리지 않아 버전 검사로는 막히지 않는다. 발송 후 구매자 사정이라 금액이 바뀌었다
    const after = await detail(orderId, cookie);
    expect(after.queueVersion).toBe(d.queueVersion);
    expect(after.refundPreview!.byFault.BUYER.refundAmount).not.toBe(oldAmount);
    const before = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { queueItems: true } });
    const r = await refund(orderId, cookie, d.queueVersion, "BUYER", oldAmount);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("refund_amount_changed");
    const now = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { queueItems: true } });
    expect(now.status).toBe("PAID");
    expect(now.refundAmount).toBeNull();
    expect(now.queueItems.map((q) => q.status)).toEqual(before.queueItems.map((q) => q.status));
    expect((await detail(orderId, cookie)).queueVersion).toBe(d.queueVersion);
    // 새 금액을 확인받아 보내면 환불된다
    const ok = await refund(orderId, cookie, d.queueVersion, "BUYER", after.refundPreview!.byFault.BUYER.refundAmount);
    expect(ok.status).toBe(200);
    expect(ok.body.refundAmount).toBe(after.refundPreview!.byFault.BUYER.refundAmount);
  });

  it("없거나 음수·소수·문자열이면 400이다", async () => {
    const { orderId, cookie } = await setup({ opened: [], shipped: false });
    const d = await detail(orderId, cookie);
    for (const bad of [undefined, null, -1, 1.5, "1000"]) expect((await refund(orderId, cookie, d.queueVersion, "SELLER", bad)).status).toBe(400);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("PAID");
  });
});
