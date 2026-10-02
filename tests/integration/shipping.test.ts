import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as shipRoute } from "../../app/api/seller/orders/[orderId]/ship/route";
import { GET as getOrderRoute } from "../../app/api/seller/orders/[orderId]/route";
import { GET as getPolicyRoute, PUT as putPolicyRoute } from "../../app/api/seller/shipping-policy/route";
import { POST as orderRoute } from "../../app/api/shop/[slug]/orders/route";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { ORDER_ERROR_MESSAGES } from "../../lib/server/orders/messages";
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
const addr = (zipCode = "06236") => ({ recipientName: "김구매", phone: "010-1234-5678", zipCode, address1: "주소 1" });
const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const product = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId: seller.id, productId: product.id, name: "1박스", stock: 50 } });
  const order = async (quantity: number, shippingAddress: unknown = addr()) => {
    const r = await createOrder(db, { sellerId: seller.id, buyerMemberId: buyer.id, items: [{ optionId: option.id, quantity }], consent, shippingAddress });
    if (!r.ok) throw new Error(r.reason);
    return r;
  };
  return { seller, grade, buyer, owner, ctx, option, order };
}

async function sellerCookie(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}

const setPolicy = (sellerId: string, data: { baseFee?: number; freeOverAmount?: number | null; remoteSurcharge?: number }) =>
  db.sellerShippingPolicy.create({ data: { sellerId, ...data } });

describe("배송비 계산", () => {
  it("판매자 설정이 없으면 기본 3,000원, 무료 기준 이상(같은 금액 포함)이면 0원, 미만이면 기본 배송비", async () => {
    const s = await shop();
    expect(await s.order(1)).toMatchObject({ shippingFee: 3000, totalAmount: 8000 });
    await setPolicy(s.seller.id, { baseFee: 2500, freeOverAmount: 10000 });
    expect(await s.order(1)).toMatchObject({ shippingFee: 2500, totalAmount: 7500 });
    expect(await s.order(2)).toMatchObject({ shippingFee: 0, totalAmount: 10000 });
    expect(await s.order(3)).toMatchObject({ shippingFee: 0, totalAmount: 15000 });
  });

  it("도서산간(제주·울릉 우편번호 범위 경계 포함)은 무료 배송이어도 추가비가 붙고, 범위 밖은 붙지 않는다", async () => {
    const s = await shop();
    await setPolicy(s.seller.id, { baseFee: 3000, freeOverAmount: 10000, remoteSurcharge: 4000 });
    expect(await s.order(1, addr("63000"))).toMatchObject({ shippingFee: 7000 });
    expect(await s.order(2, addr("63644"))).toMatchObject({ shippingFee: 4000 });
    expect(await s.order(1, addr("40200"))).toMatchObject({ shippingFee: 7000 });
    expect(await s.order(1, addr("40241"))).toMatchObject({ shippingFee: 3000 });
    expect(await s.order(1, addr("62999"))).toMatchObject({ shippingFee: 3000 });
    const remote = await db.orderShippingAddress.count({ where: { sellerId: s.seller.id, isRemote: true } });
    expect(remote).toBe(3);
  });

  it("우편번호가 범위 밖이어도 주소가 제주·울릉(시·도 단위)으로 시작하면 도서산간, 중간에 들어간 지명은 아님", async () => {
    const s = await shop();
    const at = (address1: string) => ({ ...addr("06236"), address1 });
    expect(await s.order(1, at("제주특별자치도 제주시 첨단로 1"))).toMatchObject({ shippingFee: 6000 });
    expect(await s.order(1, at("제주 서귀포시 중앙로 1"))).toMatchObject({ shippingFee: 6000 });
    expect(await s.order(1, at("경상북도 울릉군 울릉읍 도동길 1"))).toMatchObject({ shippingFee: 6000 });
    expect(await s.order(1, at("울릉군 서면 1"))).toMatchObject({ shippingFee: 6000 });
    expect(await s.order(1, at("서울 강남구 제주로 1"))).toMatchObject({ shippingFee: 3000 });
    expect(await s.order(1, at("경상북도 포항시 울릉로 1"))).toMatchObject({ shippingFee: 3000 });
  });

  it("주문 뒤 배송비 설정을 바꿔도 이미 만든 주문 금액·배송지는 그대로(스냅숏)", async () => {
    const s = await shop();
    const r = await s.order(1);
    await setPolicy(s.seller.id, { baseFee: 9000 });
    expect(await db.order.findUniqueOrThrow({ where: { id: r.orderId } })).toMatchObject({ shippingFee: 3000, totalAmount: 8000 });
  });

  it("적립 기준에는 배송비를 넣지 않는다(상품 10,000원 × 1% = 100원, 배송비 3,000원 제외)", async () => {
    const s = await shop();
    await db.rewardPolicy.create({ data: { sellerId: s.seller.id, rates: { [s.grade.id]: { card: 1, bankTransfer: 1 } } } });
    const r = await s.order(2);
    expect(r.totalAmount).toBe(13000);
    expect(await markOrderPaid(db, { sellerId: s.seller.id, orderId: r.orderId, paymentMethod: "CARD" })).toMatchObject({ ok: true });
    expect(await db.rewardLedger.findFirstOrThrow({ where: { orderId: r.orderId } })).toMatchObject({ type: "EARN", amount: 100 });
  });
});

describe("배송지 검증", () => {
  it("받는 분·연락처·우편번호·주소가 없거나 형식이 틀리면 주문을 만들지 않는다", async () => {
    const s = await shop();
    const bad = [
      undefined,
      "서울",
      { ...addr(), recipientName: "  " },
      { ...addr(), recipientName: "가".repeat(31) },
      { ...addr(), phone: "1234" },
      { ...addr(), phone: "010-1234-567a" },
      { ...addr(), zipCode: "1234" },
      { ...addr(), zipCode: "123456" },
      { ...addr(), address1: "" },
      { ...addr(), address2: "가".repeat(101) },
      { ...addr(), memo: 123 },
      // 제어문자(NUL·줄바꿈·탭)
      { ...addr(), address1: "주소\u0000 1" },
      { ...addr(), recipientName: "김\n구매" },
      { ...addr(), address2: "101\t호" },
      { ...addr(), memo: "문 앞\u0000" },
      { ...addr(), phone: "010\n12345678" },
      { ...addr(), zipCode: "0623\u0000" },
    ];
    for (const shippingAddress of bad) {
      expect(
        await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress }),
      ).toEqual({ ok: false, reason: "invalid_shipping_address" });
    }
    expect(await db.order.count()).toBe(0);
    expect(await db.orderShippingAddress.count()).toBe(0);
  });

  it("HTTP: 배송지 오류는 400과 화면 문구", async () => {
    const s = await shop();
    const login = await loginBuyer(db, { sellerId: s.seller.id, loginId: s.buyer.loginId, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const res = await orderRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, {
        method: "POST",
        headers: { ...H, cookie: `lo_buyer=${login.token}` },
        body: JSON.stringify({ items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress: { ...addr(), zipCode: "abcde" } }),
      }),
      { params: Promise.resolve({ slug: s.seller.slug }) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_shipping_address", message: ORDER_ERROR_MESSAGES.invalid_shipping_address });
    // NUL이 든 주소도 500이 아니라 400
    const nul = await orderRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/orders`, {
        method: "POST",
        headers: { ...H, cookie: `lo_buyer=${login.token}` },
        body: JSON.stringify({ items: [{ optionId: s.option.id, quantity: 1 }], consent, shippingAddress: { ...addr(), address1: "주소\u0000" } }),
      }),
      { params: Promise.resolve({ slug: s.seller.slug }) },
    );
    expect(nul.status).toBe(400);
    expect(await db.order.count()).toBe(0);
  });
});

describe("즉시 발송 처리", () => {
  async function paidOrder() {
    const s = await shop();
    const r = await s.order(1);
    expect(await markOrderPaid(db, { sellerId: s.seller.id, orderId: r.orderId, paymentMethod: "CARD" })).toMatchObject({ ok: true });
    return { ...s, orderId: r.orderId };
  }

  it("결제 완료 주문에 택배사·송장을 넣으면 배송 중이 되고, 송장 정정은 기록을 남긴다", async () => {
    const s = await paidOrder();
    const r = await shipOrder(db, s.ctx, s.orderId, { courier: "CJ", trackingNumber: "1234-5678-9012" });
    expect(r).toMatchObject({ ok: true, shipment: { courier: "CJ", trackingNumber: "123456789012", status: "IN_TRANSIT" } });
    const first = await db.shipment.findUniqueOrThrow({ where: { orderId: s.orderId } });
    expect(await shipOrder(db, s.ctx, s.orderId, { courier: "HANJIN", trackingNumber: "987654321098" })).toMatchObject({ ok: true });
    const fixed = await db.shipment.findUniqueOrThrow({ where: { orderId: s.orderId } });
    expect(fixed).toMatchObject({ courier: "HANJIN", trackingNumber: "987654321098", shippedAt: first.shippedAt });
    expect(await db.order.findUniqueOrThrow({ where: { id: s.orderId } })).toMatchObject({ status: "PAID" });
    expect(await db.auditLog.count({ where: { targetId: s.orderId, action: "order.ship" } })).toBe(1);
    expect(await db.auditLog.findFirstOrThrow({ where: { targetId: s.orderId, action: "order.shipment.update" } })).toMatchObject({
      before: { courier: "CJ", trackingNumber: "123456789012" },
    });
  });

  it("결제 대기·취소 주문, 배송 완료 주문은 발송할 수 없고, 다른 판매자 주문은 없는 주문으로 본다", async () => {
    const s = await shop();
    const pending = await s.order(1);
    expect(await shipOrder(db, s.ctx, pending.orderId, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "not_shippable" });
    await db.order.update({ where: { id: pending.orderId }, data: { status: "CANCELLED" } });
    expect(await shipOrder(db, s.ctx, pending.orderId, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "not_shippable" });

    const p = await paidOrder();
    await shipOrder(db, p.ctx, p.orderId, { courier: "CJ", trackingNumber: "123456789012" });
    await db.shipment.update({ where: { orderId: p.orderId }, data: { status: "DELIVERED" } });
    expect(await shipOrder(db, p.ctx, p.orderId, { courier: "CJ", trackingNumber: "999999999999" })).toEqual({ ok: false, reason: "not_shippable" });

    expect(await shipOrder(db, s.ctx, p.orderId, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "not_found" });
    expect(await db.shipment.count()).toBe(1);
  });

  it("재고 부족으로 차감되지 않은 주문, 배송지가 없는 주문은 발송할 수 없다", async () => {
    const s = await shop();
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 1 } });
    const [a, b] = [await s.order(1), await s.order(1)];
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: a.orderId, paymentMethod: "CARD" });
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: b.orderId, paymentMethod: "CARD" });
    expect(await db.order.findUniqueOrThrow({ where: { id: b.orderId } })).toMatchObject({ status: "PAID", stockShortageAt: expect.any(Date) });
    expect(await shipOrder(db, s.ctx, b.orderId, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "not_shippable" });
    expect(await shipOrder(db, s.ctx, a.orderId, { courier: "CJ", trackingNumber: "123456789012" })).toMatchObject({ ok: true });

    // 배송지 없이 만들어진 결제 완료 주문(이 PR 이전 주문 등)
    const legacy = await db.order.create({
      data: { sellerId: s.seller.id, orderNo: 99, buyerMemberId: s.buyer.id, status: "PAID", broadcastNicknameSnapshot: "닉", totalAmount: 5000, paidAt: new Date() },
    });
    expect(await shipOrder(db, s.ctx, legacy.id, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "not_shippable" });
    expect(await db.shipment.count()).toBe(1);
  });

  it("발송한 주문을 환불하면 재고를 되돌리지 않고 배송 기록은 그대로, 감사 로그에 발송 후 환불을 남긴다(발송 전 환불은 기존대로 복구)", async () => {
    const s = await shop();
    await db.productOption.update({ where: { id: s.option.id }, data: { stock: 10 } });
    const lv = async () => (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).liveVersion;
    const stock = async () => (await db.productOption.findUniqueOrThrow({ where: { id: s.option.id } })).stock;

    const shipped = await s.order(2);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: shipped.orderId, paymentMethod: "CARD" });
    expect(await stock()).toBe(8);
    await shipOrder(db, s.ctx, shipped.orderId, { courier: "CJ", trackingNumber: "123456789012" });
    expect(await refundOrder(db, s.ctx, shipped.orderId, { reason: "구매자 요청", expectedLiveVersion: await lv() })).toMatchObject({
      ok: true,
      value: { restockedItemIds: [] },
    });
    expect(await stock()).toBe(8);
    expect(await db.shipment.findUniqueOrThrow({ where: { orderId: shipped.orderId } })).toMatchObject({ status: "IN_TRANSIT" });
    expect(await db.stockMovement.count({ where: { orderId: shipped.orderId, reason: "REFUND" } })).toBe(0);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "order.refund", targetId: shipped.orderId } })).toMatchObject({
      after: { status: "REFUNDED", restockedItems: 0, shippedBeforeRefund: true, shipmentStatus: "IN_TRANSIT" },
    });

    const notShipped = await s.order(1);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: notShipped.orderId, paymentMethod: "CARD" });
    expect(await stock()).toBe(7);
    expect(await refundOrder(db, s.ctx, notShipped.orderId, { reason: "구매자 요청", expectedLiveVersion: await lv() })).toMatchObject({ ok: true });
    expect(await stock()).toBe(8);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "order.refund", targetId: notShipped.orderId } })).toMatchObject({
      after: { shippedBeforeRefund: false },
    });
  });

  it("목록에 없는 택배사·형식이 틀린 송장은 거부", async () => {
    const s = await paidOrder();
    for (const input of [
      { courier: "FEDEX", trackingNumber: "123456789012" },
      { courier: "toString", trackingNumber: "123456789012" },
      { courier: "CJ", trackingNumber: "1234" },
      { courier: "CJ", trackingNumber: "12345678<script>" },
      { courier: "CJ", trackingNumber: 123456789012 },
    ]) {
      expect(await shipOrder(db, s.ctx, s.orderId, input)).toEqual({ ok: false, reason: "invalid_shipment" });
    }
    expect(await db.shipment.count()).toBe(0);
  });

  it("HTTP: 배송 권한 없는 직원·마스터 대리 조회는 403, 권한 있으면 200, 상태 오류는 409와 문구", async () => {
    const s = await paidOrder();
    const call = (cookie: string, orderId = s.orderId) =>
      shipRoute(
        new Request(`http://localhost:3000/api/seller/orders/${orderId}/ship`, {
          method: "POST",
          headers: { ...H, cookie },
          body: JSON.stringify({ courier: "LOTTE", trackingNumber: "123456789012" }),
        }),
        { params: Promise.resolve({ orderId }) },
      );
    const broadcaster = await createSellerUser(s.seller.id, "BROADCASTER");
    expect((await call(await sellerCookie(broadcaster.email))).status).toBe(403);
    expect(await shipOrder(db, { ...s.ctx, readOnly: true }, s.orderId, { courier: "CJ", trackingNumber: "123456789012" }).catch((e) => e.status)).toBe(403);
    const manager = await createSellerUser(s.seller.id, "MANAGER");
    const ok = await call(await sellerCookie(manager.email));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ courier: "LOTTE", status: "IN_TRANSIT" });

    const pending = await s.order(1);
    const res = await call(await sellerCookie(s.owner.email), pending.orderId);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "not_shippable", message: "결제가 끝난 주문만 발송할 수 있어요" });
  });

  it("주문 조회: 배송지는 고객정보 권한이 있을 때만 주고(열람 기록), 없으면 도서산간 여부만", async () => {
    const s = await paidOrder();
    await shipOrder(db, s.ctx, s.orderId, { courier: "CJ", trackingNumber: "123456789012" });
    const get = async (email: string) =>
      (
        await getOrderRoute(new Request(`http://localhost:3000/api/seller/orders/${s.orderId}`, { headers: { ...H, cookie: await sellerCookie(email) } }), {
          params: Promise.resolve({ orderId: s.orderId }),
        })
      ).json();
    const noPii = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const hidden = await get(noPii.email);
    expect(hidden.shippingAddress).toEqual({ isRemote: false });
    expect(hidden.shipment).toMatchObject({ courier: "CJ", trackingNumber: "123456789012" });
    expect(await db.auditLog.count({ where: { action: "customer.pii.view" } })).toBe(0);
    const shown = await get(s.owner.email);
    expect(shown.shippingAddress).toMatchObject({ recipientName: "김구매", phone: "01012345678", zipCode: "06236" });
    expect(await db.auditLog.count({ where: { action: "customer.pii.view" } })).toBe(1);
  });
});

describe("판매자 배송비 설정 API", () => {
  const put = (cookie: string, body: unknown) =>
    putPolicyRoute(new Request("http://localhost:3000/api/seller/shipping-policy", { method: "PUT", headers: { ...H, cookie }, body: JSON.stringify(body) }));

  it("설정이 없으면 기본값을 주고, 저장하면 다음 주문부터 반영된다(기록 남김)", async () => {
    const s = await shop();
    const cookie = await sellerCookie(s.owner.email);
    const got = await (await getPolicyRoute(new Request("http://localhost:3000/api/seller/shipping-policy", { headers: { ...H, cookie } }))).json();
    expect(got.policy).toEqual({ baseFee: 3000, freeOverAmount: null, remoteSurcharge: 3000, remoteZipRanges: [[63000, 63644], [40200, 40240]] });
    expect(got.couriers).toMatchObject({ CJ: "CJ대한통운" });
    const res = await put(cookie, { baseFee: 0, freeOverAmount: null, remoteSurcharge: 5000, remoteZipRanges: [[63000, 63644]] });
    expect(res.status).toBe(200);
    expect(await s.order(1, addr("40200"))).toMatchObject({ shippingFee: 0 });
    expect(await s.order(1, addr("63001"))).toMatchObject({ shippingFee: 5000 });
    expect(await db.auditLog.count({ where: { action: "shipping_policy.update", sellerId: s.seller.id } })).toBe(1);
  });

  it("음수·소수·범위 초과·뒤집힌 우편번호 범위는 400과 문구, 배송 권한만 있는 직원은 403", async () => {
    const s = await shop();
    const cookie = await sellerCookie(s.owner.email);
    const ok = { baseFee: 3000, freeOverAmount: 50000, remoteSurcharge: 3000, remoteZipRanges: [] };
    for (const body of [
      { ...ok, baseFee: -1 },
      { ...ok, baseFee: 1.5 },
      { ...ok, baseFee: 100_001 },
      { ...ok, freeOverAmount: 0 },
      { ...ok, remoteSurcharge: "3000" },
      { ...ok, remoteZipRanges: [[63644, 63000]] },
      { ...ok, remoteZipRanges: [[63000]] },
      { ...ok, remoteZipRanges: "63000" },
    ]) {
      const res = await put(cookie, body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_shipping_policy", message: ORDER_ERROR_MESSAGES.invalid_shipping_policy });
    }
    expect(await db.sellerShippingPolicy.count()).toBe(0);
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    expect((await put(await sellerCookie(staff.email), ok)).status).toBe(403);
  });
});
