import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as adjustRoute } from "../../app/api/seller/products/[productId]/options/[optionId]/stock-adjust/route";
import { PUT as policyPut, GET as policyGet } from "../../app/api/seller/order-policy/route";
import { PUT as shippingPut } from "../../app/api/seller/shipping-policy/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES, purchaseRestrictedMessage } from "../../lib/server/orders/messages";
import { cancelOverdueOrders, listPaymentDueSoon } from "../../lib/server/orders/overdue";
import { shipOrder } from "../../lib/server/orders/ship";
import { createOption, createProduct, updateProduct } from "../../lib/server/products/manage";
import { adjustStock, restoreOrderStock } from "../../lib/server/products/stock";
import { INT4_MAX } from "../../lib/server/orders/shipping";
import type { PrismaClient } from "@prisma/client";
import { cancelPendingOrder, markOrderPaid, refundOrder } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "01012345678", zipCode: "06236", address1: "서울 강남구 테헤란로 1" };
const HOUR = 60 * 60 * 1000;

async function shop() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const product = async (mode: "ORDER" | "PAYMENT", stock: number) => {
    const r = await createProduct(db, ctx, { name: `상품 ${mode}`, price: 1000, status: "ON_SALE", stockDeductMode: mode, options: [{ name: "기본", stock }] });
    if (!r.ok) throw new Error(r.reason);
    return { productId: r.value.id, optionId: r.value.options[0].id };
  };
  const place = (items: { optionId: string; quantity: number }[], buyerMemberId = buyer.id) =>
    createOrder(db, { sellerId: seller.id, buyerMemberId, items, consent, shippingAddress: addr });
  const order = async (items: { optionId: string; quantity: number }[], buyerMemberId = buyer.id) => {
    const r = await place(items, buyerMemberId);
    if (!r.ok) throw new Error(r.reason);
    return r.orderId;
  };
  const lv = async () => (await db.seller.findUniqueOrThrow({ where: { id: seller.id } })).liveVersion;
  return { seller, grade, owner, ctx, buyer, product, place, order, lv };
}
const stockOf = async (optionId: string) => (await db.productOption.findUniqueOrThrow({ where: { id: optionId } })).stock;
async function sellerCookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

describe("재고 차감 기준(상품별 ORDER·PAYMENT)", () => {
  it("주문 때 차감(ORDER) 상품은 주문하면 바로 빠지고 결제 때 다시 빼지 않는다. 결제 때 차감(PAYMENT, 기본)은 지금처럼 결제 때 뺀다", async () => {
    const s = await shop();
    const ord = await s.product("ORDER", 5);
    const pay = await s.product("PAYMENT", 5);
    const id = await s.order([{ optionId: ord.optionId, quantity: 2 }, { optionId: pay.optionId, quantity: 1 }]);
    expect(await stockOf(ord.optionId)).toBe(3);
    expect(await stockOf(pay.optionId)).toBe(5);
    const items = await db.orderItem.findMany({ where: { orderId: id } });
    expect(items.find((i) => i.optionId === ord.optionId)!.stockDeductedAt).toEqual(expect.any(Date));
    expect(items.find((i) => i.optionId === pay.optionId)!.stockDeductedAt).toBeNull();
    expect(await markOrderPaid(db, { sellerId: s.seller.id, orderId: id, paymentMethod: "CARD" })).toMatchObject({ ok: true, value: { stockShortage: false } });
    expect(await stockOf(ord.optionId)).toBe(3);
    expect(await stockOf(pay.optionId)).toBe(4);
    expect(await db.stockMovement.count({ where: { orderId: id, reason: "ORDER" } })).toBe(2);
    expect(await db.orderItem.count({ where: { orderId: id, stockDeductedAt: null } })).toBe(0);
    expect((await db.product.findUniqueOrThrow({ where: { id: pay.productId } })).stockDeductMode).toBe("PAYMENT");
  });

  it("[경합] 주문 때 차감 상품의 마지막 1개를 5명이 동시에 주문하면 한 명만 가져가고 재고는 음수가 되지 않는다(실패한 주문은 남지 않음)", async () => {
    for (let round = 0; round < 3; round++) {
      const s = await shop();
      const ord = await s.product("ORDER", 1);
      const buyers = [s.buyer, ...(await Promise.all(Array.from({ length: 4 }, () => createLoginBuyer(s.seller.id, s.grade.id))))];
      const rs = await Promise.all(buyers.map((b) => s.place([{ optionId: ord.optionId, quantity: 1 }], b.id)));
      expect(rs.filter((r) => r.ok)).toHaveLength(1);
      expect(rs.filter((r) => !r.ok && r.reason === "out_of_stock")).toHaveLength(4);
      expect(await stockOf(ord.optionId)).toBe(0);
      expect(await db.order.count({ where: { sellerId: s.seller.id } })).toBe(1);
      expect(await db.stockMovement.count({ where: { optionId: ord.optionId, reason: "ORDER" } })).toBe(1);
    }
  });

  it("주문 때 차감 상품이 모자라면 같은 주문의 다른 품목 차감도 되돌리고 주문을 만들지 않는다", async () => {
    const s = await shop();
    const a = await s.product("ORDER", 5);
    const b = await s.product("ORDER", 1);
    expect(await s.place([{ optionId: a.optionId, quantity: 2 }, { optionId: b.optionId, quantity: 2 }])).toEqual({ ok: false, reason: "out_of_stock" });
    expect(await stockOf(a.optionId)).toBe(5);
    expect(await db.order.count()).toBe(0);
  });

  it("상품 차감 기준을 바꾸면 다음 주문부터: 결제 때 차감으로 받은 주문은 나중에 주문 때 차감으로 바꿔도 결제 때 뺀다", async () => {
    const s = await shop();
    const p = await s.product("PAYMENT", 5);
    const id = await s.order([{ optionId: p.optionId, quantity: 1 }]);
    expect(await updateProduct(db, s.ctx, p.productId, { stockDeductMode: "ORDER" })).toMatchObject({ ok: true });
    expect(await stockOf(p.optionId)).toBe(5);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: id, paymentMethod: "CARD" });
    expect(await stockOf(p.optionId)).toBe(4);
    expect(await updateProduct(db, s.ctx, p.productId, { stockDeductMode: "SHIP" })).toEqual({ ok: false, reason: "invalid_product" });
  });

  it("결제 때 차감 품목이 모자라 재고 부족으로 결제되면, 주문 때 뺀 품목은 그대로이고 환불하면 그 품목만 되돌린다", async () => {
    const s = await shop();
    const ord = await s.product("ORDER", 5);
    const pay = await s.product("PAYMENT", 1);
    const id = await s.order([{ optionId: ord.optionId, quantity: 2 }, { optionId: pay.optionId, quantity: 1 }]);
    await db.productOption.update({ where: { id: pay.optionId }, data: { stock: 0 } });
    expect(await markOrderPaid(db, { sellerId: s.seller.id, orderId: id, paymentMethod: "CARD" })).toMatchObject({ ok: true, value: { stockShortage: true } });
    expect(await stockOf(ord.optionId)).toBe(3);
    const r = await refundOrder(db, s.ctx, id, { reason: "재고 부족", expectedLiveVersion: await s.lv() });
    expect(r).toMatchObject({ ok: true, value: { restockedItemIds: [expect.any(String)] } });
    expect(await stockOf(ord.optionId)).toBe(5);
    expect(await stockOf(pay.optionId)).toBe(0);
  });
});

describe("취소·반품 때 재고 자동 복구", () => {
  it("주문 때 차감 상품: 결제 전 취소·미입금 자동 취소에서 되돌리고(CANCEL 이력), 발송 전 환불도 되돌린다", async () => {
    const s = await shop();
    const ord = await s.product("ORDER", 10);
    const a = await s.order([{ optionId: ord.optionId, quantity: 2 }]);
    const b = await s.order([{ optionId: ord.optionId, quantity: 3 }]);
    const c = await s.order([{ optionId: ord.optionId, quantity: 1 }]);
    expect(await stockOf(ord.optionId)).toBe(4);
    expect(await cancelPendingOrder(db, s.ctx, a, { reason: "구매자 요청", expectedLiveVersion: await s.lv() })).toMatchObject({ ok: true });
    expect(await stockOf(ord.optionId)).toBe(6);
    await db.order.update({ where: { id: b }, data: { paymentDueAt: new Date(Date.now() - HOUR), createdAt: new Date(Date.now() - 2 * 24 * HOUR) } });
    expect((await cancelOverdueOrders(db)).cancelled).toEqual([b]);
    expect(await stockOf(ord.optionId)).toBe(9);
    expect(await db.stockMovement.count({ where: { optionId: ord.optionId, reason: "CANCEL" } })).toBe(2);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: c, paymentMethod: "CARD" });
    expect(await refundOrder(db, s.ctx, c, { reason: "요청", expectedLiveVersion: await s.lv() })).toMatchObject({ ok: true });
    expect(await stockOf(ord.optionId)).toBe(10);
  });

  it("판매자가 자동 복구를 끄면 결제 전 취소·자동 취소·발송 전 환불 모두 되돌리지 않는다. 결제 때 차감 상품의 결제 전 취소는 원래 되돌릴 것이 없다", async () => {
    const s = await shop();
    const c = await sellerCookie(s.owner.email);
    const ord = await s.product("ORDER", 10);
    const pay = await s.product("PAYMENT", 10);
    const p0 = await s.order([{ optionId: pay.optionId, quantity: 1 }]);
    expect(await cancelPendingOrder(db, s.ctx, p0, { reason: "요청", expectedLiveVersion: await s.lv() })).toMatchObject({ ok: true });
    expect(await stockOf(pay.optionId)).toBe(10);
    const res = await policyPut(new Request("http://localhost:3000/api/seller/order-policy", { method: "PUT", headers: { ...H, cookie: c }, body: JSON.stringify({ autoCancelEnabled: true, paymentDueHours: 240, unpaidRestrictionEnabled: true, restockOnCancel: false }) }));
    expect(res.status).toBe(200);
    const a = await s.order([{ optionId: ord.optionId, quantity: 2 }]);
    const b = await s.order([{ optionId: ord.optionId, quantity: 2 }]);
    const d = await s.order([{ optionId: pay.optionId, quantity: 1 }]);
    await cancelPendingOrder(db, s.ctx, a, { reason: "요청", expectedLiveVersion: await s.lv() });
    await db.order.update({ where: { id: b }, data: { paymentDueAt: new Date(Date.now() - HOUR), createdAt: new Date(Date.now() - 2 * 24 * HOUR) } });
    await cancelOverdueOrders(db);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: d, paymentMethod: "CARD" });
    expect(await refundOrder(db, s.ctx, d, { reason: "요청", expectedLiveVersion: await s.lv() })).toMatchObject({ ok: true, value: { restockedItemIds: [] } });
    expect(await stockOf(ord.optionId)).toBe(6);
    expect(await stockOf(pay.optionId)).toBe(9);
    expect(await db.stockMovement.count({ where: { reason: { in: ["CANCEL", "REFUND"] } } })).toBe(0);
    // 빼고 보내면 지금 값을 그대로 둔다
    await policyPut(new Request("http://localhost:3000/api/seller/order-policy", { method: "PUT", headers: { ...H, cookie: c }, body: JSON.stringify({ autoCancelEnabled: true, paymentDueHours: 240, unpaidRestrictionEnabled: true }) }));
    expect((await (await policyGet(new Request("http://localhost:3000/api/seller/order-policy", { headers: { ...H, cookie: c } }))).json()).policy.restockOnCancel).toBe(false);
    const bad = await policyPut(new Request("http://localhost:3000/api/seller/order-policy", { method: "PUT", headers: { ...H, cookie: c }, body: JSON.stringify({ autoCancelEnabled: true, paymentDueHours: 240, unpaidRestrictionEnabled: true, restockOnCancel: "no" }) }));
    expect(bad.status).toBe(400);
  });

  it("발송 후 환불은 주문 때 차감 상품도 되돌리지 않고, 같은 품목을 두 번 되돌리지 않는다", async () => {
    const s = await shop();
    const ord = await s.product("ORDER", 10);
    const id = await s.order([{ optionId: ord.optionId, quantity: 2 }]);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: id, paymentMethod: "CARD" });
    await shipOrder(db, s.ctx, id, { courier: "CJ", trackingNumber: "123456789012" });
    expect(await refundOrder(db, s.ctx, id, { reason: "요청", expectedLiveVersion: await s.lv() })).toMatchObject({ ok: true, value: { restockedItemIds: [] } });
    expect(await stockOf(ord.optionId)).toBe(8);

    const other = await s.order([{ optionId: ord.optionId, quantity: 1 }]);
    const now = new Date();
    const actor = { actorType: "SYSTEM" as const, actorId: null };
    const first = await db.$transaction((tx) => restoreOrderStock(tx, { sellerId: s.seller.id, orderId: other, reason: "CANCEL", now, actor }));
    const second = await db.$transaction((tx) => restoreOrderStock(tx, { sellerId: s.seller.id, orderId: other, reason: "CANCEL", now, actor }));
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
    expect(await stockOf(ord.optionId)).toBe(8);
  });
});

describe("수동 재고 증감", () => {
  it("사유와 함께 빼고 더하면 MANUAL 이력(수량·사유·직원·시각)과 감사 로그를 남긴다", async () => {
    const s = await shop();
    const p = await s.product("PAYMENT", 10);
    const c = await sellerCookie(s.owner.email);
    const call = (body: unknown, productId = p.productId, optionId = p.optionId, cookie = c) =>
      adjustRoute(new Request(`http://localhost:3000/api/seller/products/${productId}/options/${optionId}/stock-adjust`, { method: "POST", headers: { ...H, cookie }, body: JSON.stringify(body) }), {
        params: Promise.resolve({ productId, optionId }),
      });
    const res = await call({ delta: -3, reason: "이벤트 증정" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ optionId: p.optionId, stock: 7 });
    expect((await call({ delta: 2, reason: "반품 입고" })).status).toBe(200);
    expect(await stockOf(p.optionId)).toBe(9);
    expect(await db.stockMovement.findFirstOrThrow({ where: { optionId: p.optionId, delta: -3 } })).toMatchObject({ reason: "MANUAL", note: "이벤트 증정", actorType: "SELLER_USER", actorId: s.owner.id, createdAt: expect.any(Date) });
    expect(await db.auditLog.count({ where: { action: "product_option.stock_adjust", targetId: p.optionId } })).toBe(2);

    for (const body of [{ delta: 0, reason: "x" }, { delta: 1.5, reason: "x" }, { delta: "3", reason: "x" }, { delta: -1 }, { delta: -1, reason: "  " }, { delta: -1, reason: "가".repeat(101) }, { delta: -1, reason: "증정" + "\u0000" }]) {
      const r = await call(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toEqual({ error: "invalid_stock_adjust", message: ORDER_ERROR_MESSAGES.invalid_stock_adjust });
    }
    expect((await call({ delta: -1, reason: "가".repeat(100) })).status).toBe(200);
    const over = await call({ delta: -9, reason: "증정" });
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: "insufficient_stock", message: ORDER_ERROR_MESSAGES.insufficient_stock });
    expect(await stockOf(p.optionId)).toBe(8);

    const other = await shop();
    const op = await other.product("PAYMENT", 5);
    expect((await call({ delta: -1, reason: "침입" }, op.productId, op.optionId)).status).toBe(404);
    expect((await call({ delta: -1, reason: "엇갈림" }, p.productId, op.optionId)).status).toBe(404);
    const broadcaster = await createSellerUser(s.seller.id, "BROADCASTER");
    expect((await call({ delta: -1, reason: "x" }, p.productId, p.optionId, await sellerCookie(broadcaster.email))).status).toBe(403);
    await expect(adjustStock(db, { ...s.ctx, readOnly: true }, p.productId, p.optionId, { delta: -1, reason: "x" })).rejects.toMatchObject({ status: 403 });
    expect(await stockOf(op.optionId)).toBe(5);
    expect(await stockOf(p.optionId)).toBe(8);
  });

  it("[경합] 결제 차감 5건과 수동 차감을 동시에 해도 합계가 맞고 음수가 되지 않으며, 모자라면 수동 차감은 409", async () => {
    for (const [stock, manual] of [[10, -3], [6, -3]] as const) {
      const s = await shop();
      const p = await s.product("PAYMENT", stock);
      const buyers = await Promise.all(Array.from({ length: 5 }, () => createLoginBuyer(s.seller.id, s.grade.id)));
      const ids = [];
      for (const b of buyers) ids.push(await s.order([{ optionId: p.optionId, quantity: 1 }], b.id));
      const [adj, ...paid] = await Promise.all([
        adjustStock(db, s.ctx, p.productId, p.optionId, { delta: manual, reason: "이벤트 증정" }),
        ...ids.map((orderId) => markOrderPaid(db, { sellerId: s.seller.id, orderId, paymentMethod: "CARD" })),
      ]);
      const final = await stockOf(p.optionId);
      expect(final).toBeGreaterThanOrEqual(0);
      const moved = await db.stockMovement.aggregate({ where: { optionId: p.optionId }, _sum: { delta: true } });
      // 처음 재고(등록 때 MANUAL 이력 포함) + 이후 이력 합계 = 지금 재고
      expect(moved._sum.delta).toBe(final);
      const paidDeducted = paid.filter((r) => r.ok && !r.value.stockShortage).length;
      expect(final).toBe(stock - paidDeducted - (adj.ok ? -manual : 0));
      if (stock === 10) {
        expect(adj).toMatchObject({ ok: true });
        expect(final).toBe(2);
      } else if (!adj.ok) {
        expect(adj.reason).toBe("insufficient_stock");
      }
    }
  });
});

describe("상품명 글자 수(코드포인트)", () => {
  it("이모지도 1자로 세어 100자까지 받고, 101자는 product_name_too_long(문구 따로)", async () => {
    const s = await shop();
    const emoji = "\u{1f525}";
    expect(await createProduct(db, s.ctx, { name: emoji.repeat(100), price: 1000 })).toMatchObject({ ok: true });
    expect(await createProduct(db, s.ctx, { name: "가".repeat(99) + emoji, price: 1000 })).toMatchObject({ ok: true });
    expect(await createProduct(db, s.ctx, { name: emoji.repeat(101), price: 1000 })).toEqual({ ok: false, reason: "product_name_too_long" });
    expect(await createProduct(db, s.ctx, { name: "가".repeat(101), price: 1000 })).toEqual({ ok: false, reason: "product_name_too_long" });
    expect(await createProduct(db, s.ctx, { name: "가\u202e", price: 1000 })).toEqual({ ok: false, reason: "invalid_product" });
    const p = await createProduct(db, s.ctx, { name: "짧은 이름", price: 1000 });
    if (!p.ok) throw new Error(p.reason);
    expect(await updateProduct(db, s.ctx, p.value.id, { name: "가".repeat(101) })).toEqual({ ok: false, reason: "product_name_too_long" });
    expect(ORDER_ERROR_MESSAGES.product_name_too_long).toBe("상품명은 100자까지 쓸 수 있어요");
  });
});

describe("미입금 알림 시점", () => {
  it("입금 기간이 하루보다 길면 기한 하루 전부터, 하루 이하면 1시간 전부터 대상이고, 기한이 지나면 빠진다", async () => {
    const s = await shop();
    const p = await s.product("PAYMENT", 100);
    const long = await s.order([{ optionId: p.optionId, quantity: 1 }]);
    const short = await s.order([{ optionId: p.optionId, quantity: 1 }]);
    const exactDay = await s.order([{ optionId: p.optionId, quantity: 1 }]);
    const base = new Date("2026-11-01T00:00:00Z").getTime();
    await db.order.update({ where: { id: long }, data: { createdAt: new Date(base), paymentDueAt: new Date(base + 240 * HOUR) } });
    await db.order.update({ where: { id: short }, data: { createdAt: new Date(base), paymentDueAt: new Date(base + 12 * HOUR) } });
    await db.order.update({ where: { id: exactDay }, data: { createdAt: new Date(base), paymentDueAt: new Date(base + 24 * HOUR) } });
    const at = async (ms: number) => (await listPaymentDueSoon(db, { now: new Date(ms) })).map((o) => o.id);
    // 10일 주문: 기한 25시간 전에는 아직, 하루 전 정각부터 대상
    expect(await at(base + 215 * HOUR)).not.toContain(long);
    expect(await at(base + 216 * HOUR)).toContain(long);
    expect(await at(base + 240 * HOUR - 1)).toContain(long);
    expect(await at(base + 240 * HOUR)).not.toContain(long);
    // 12시간 주문: 1시간 전부터
    expect(await at(base + 11 * HOUR - 1)).not.toContain(short);
    expect(await at(base + 11 * HOUR)).toContain(short);
    // 딱 하루(24시간) 주문은 하루 이하라 1시간 전부터
    expect(await at(base + 22 * HOUR)).not.toContain(exactDay);
    expect(await at(base + 23 * HOUR)).toContain(exactDay);
  });
});

describe("검수 후속 P2·배송비 무료 유형", () => {
  it("구매 제한 안내는 초가 있으면 분을 올림해 실제로 풀리는 시각보다 이르게 안내하지 않는다", () => {
    expect(purchaseRestrictedMessage(new Date("2026-11-02T06:05:30Z"))).toBe("11월 2일 오후 3시 6분부터 다시 주문할 수 있어요");
    expect(purchaseRestrictedMessage(new Date("2026-11-02T06:59:00.001Z"))).toBe("11월 2일 오후 4시부터 다시 주문할 수 있어요");
    expect(purchaseRestrictedMessage(new Date("2026-11-02T06:05:00Z"))).toBe("11월 2일 오후 3시 5분부터 다시 주문할 수 있어요");
  });

  it("무료(0원) 배송 유형이면 기본 배송비·무료 기준과 상관없이 0원이고, 도서산간 추가비는 붙는다", async () => {
    const s = await shop();
    const p = await s.product("PAYMENT", 100);
    const c = await sellerCookie(s.owner.email);
    const put = (body: unknown) => shippingPut(new Request("http://localhost:3000/api/seller/shipping-policy", { method: "PUT", headers: { ...H, cookie: c }, body: JSON.stringify(body) }));
    const policy = { freeShipping: true, baseFee: 3000, freeOverAmount: 50000, remoteSurcharge: 4000, remoteZipRanges: [[63000, 63644]] };
    expect((await put(policy)).status).toBe(200);
    expect(await s.place([{ optionId: p.optionId, quantity: 1 }])).toMatchObject({ ok: true, shippingFee: 0, totalAmount: 1000 });
    expect(await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: p.optionId, quantity: 1 }], consent, shippingAddress: { ...addr, zipCode: "63100" } })).toMatchObject({
      ok: true,
      shippingFee: 4000,
    });
    expect((await put({ ...policy, freeShipping: "yes" })).status).toBe(400);
    expect((await put({ ...policy, freeShipping: false })).status).toBe(200);
    expect(await s.place([{ optionId: p.optionId, quantity: 1 }])).toMatchObject({ ok: true, shippingFee: 3000 });
  });
});

describe("검수 후속(#84)", () => {
  it("복구하면 정수 상한을 넘는 품목은 500 없이 건너뛰고(기록 남김) 취소는 끝난다. 수동으로 상한을 넘겨 더하면 409 stock_too_large", async () => {
    const s = await shop();
    const ord = await s.product("ORDER", 10);
    const id = await s.order([{ optionId: ord.optionId, quantity: 3 }]);
    await db.productOption.update({ where: { id: ord.optionId }, data: { stock: INT4_MAX - 1 } });
    expect(await cancelPendingOrder(db, s.ctx, id, { reason: "요청", expectedLiveVersion: await s.lv() })).toMatchObject({ ok: true });
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "CANCELLED" });
    expect(await stockOf(ord.optionId)).toBe(INT4_MAX - 1);
    expect(await db.orderItem.findFirstOrThrow({ where: { orderId: id } })).toMatchObject({ stockRestoredAt: null });
    expect(await db.auditLog.count({ where: { action: "stock.restore_skipped" } })).toBe(1);

    const r = await adjustStock(db, s.ctx, ord.productId, ord.optionId, { delta: 2, reason: "입고" });
    expect(r).toEqual({ ok: false, reason: "stock_too_large" });
    const c = await sellerCookie(s.owner.email);
    const res = await adjustRoute(
      new Request(`http://localhost:3000/api/seller/products/${ord.productId}/options/${ord.optionId}/stock-adjust`, { method: "POST", headers: { ...H, cookie: c }, body: JSON.stringify({ delta: 2, reason: "입고" }) }),
      { params: Promise.resolve({ productId: ord.productId, optionId: ord.optionId }) },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "stock_too_large", message: "재고는 21억 개까지 넣을 수 있어요" });
    expect(await adjustStock(db, s.ctx, ord.productId, ord.optionId, { delta: 1, reason: "입고" })).toMatchObject({ ok: true, value: { stock: INT4_MAX } });
  });

  it("자동 취소에서 한 건이 실패해도 나머지 주문은 계속 처리하고, 실패한 건은 감사 로그를 남긴 뒤 다음 실행에서 처리된다", async () => {
    const s = await shop();
    const p = await s.product("PAYMENT", 100);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push(await s.order([{ optionId: p.optionId, quantity: 1 }]));
    for (const [i, id] of ids.entries()) {
      await db.order.update({ where: { id }, data: { paymentDueAt: new Date(Date.now() - (3 - i) * HOUR), createdAt: new Date(Date.now() - 2 * 24 * HOUR) } });
    }
    // 첫 주문의 트랜잭션만 실패하게 한다(DB 장애 흉내)
    let calls = 0;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "$transaction") {
          return (fn: unknown) => {
            calls += 1;
            if (calls === 1) return Promise.reject(new Error("simulated failure"));
            return (target.$transaction as (f: unknown) => Promise<unknown>)(fn);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as PrismaClient;
    const run = await cancelOverdueOrders(flaky);
    expect(run.failed).toEqual([ids[0]]);
    expect(run.cancelled.sort()).toEqual([ids[1], ids[2]].sort());
    expect(await db.order.findUniqueOrThrow({ where: { id: ids[0] } })).toMatchObject({ status: "PENDING_PAYMENT" });
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "order.auto_cancel_failed", targetId: ids[0] } })).toMatchObject({ reason: "simulated failure" });
    // 같은 구매자의 세 번째 자동 취소라 구매 제한도 함께 생긴다
    expect(await cancelOverdueOrders(db)).toMatchObject({ cancelled: [ids[0]], restricted: [{ buyerMemberId: s.buyer.id }], failed: [] });
  });

  it("함께 등록한 옵션은 입력 순서대로 나오고(같은 시각이어도), 나중에 추가한 옵션은 맨 뒤", async () => {
    const s = await shop();
    const r = await createProduct(db, s.ctx, { name: "순서", price: 1000, options: Array.from({ length: 8 }, (_, i) => ({ name: `옵션${i}` })) });
    if (!r.ok) throw new Error(r.reason);
    expect(r.value.options.map((o) => o.name)).toEqual(Array.from({ length: 8 }, (_, i) => `옵션${i}`));
    expect(r.value.options.map((o) => o.sortOrder)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const added = await createOption(db, s.ctx, r.value.id, { name: "추가" });
    expect(added.ok && added.value.options.at(-1)).toMatchObject({ name: "추가", sortOrder: 8 });
  });
});

