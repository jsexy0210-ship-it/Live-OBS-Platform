import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as approveRoute } from "../../app/api/seller/refund-requests/[id]/approve/route";
import { POST as rejectRoute } from "../../app/api/seller/refund-requests/[id]/reject/route";
import { GET as sellerDetailRoute } from "../../app/api/seller/refund-requests/[id]/route";
import { GET as buyerGetRoute, POST as buyerPostRoute } from "../../app/api/shop/[slug]/refund-requests/route";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import {
  BUYER_REFUND_REQUEST_MESSAGES,
  SELLER_REFUND_REQUEST_MESSAGES,
  approveRefundRequest,
  buyerRefundRequestContext,
  cancelRefundRequest,
  createRefundRequest,
  getSellerRefundRequest,
  listSellerRefundRequests,
  rejectRefundRequest,
} from "../../lib/server/payments/refundRequest";
import { markOrderPaid, refundOrder } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 구매자 환불 요청(SA-023 · SH-022, MASTER 배정 2026-10-05): 요청 → 파트너스 승인(= 환불) 또는 거절(사유 필수), 구매자 철회.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };

// 박스 7,000원 × 1(개봉 대기), 팩 5,000원 × 3(대기에서 빠짐), 배송비 3,000원
async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const box = await db.product.create({ data: { sellerId: seller.id, name: "박스", price: 7000, status: "ON_SALE" } });
  const pack = await db.product.create({ data: { sellerId: seller.id, name: "팩", price: 5000, status: "ON_SALE" } });
  const boxOpt = await db.productOption.create({ data: { sellerId: seller.id, productId: box.id, name: "1개", stock: 50 } });
  const packOpt = await db.productOption.create({ data: { sellerId: seller.id, productId: pack.id, name: "1개", stock: 50 } });
  const o = await createOrder(db, {
    sellerId: seller.id,
    buyerMemberId: buyer.id,
    items: [
      { optionId: boxOpt.id, quantity: 1 },
      { optionId: packOpt.id, quantity: 3 },
    ],
    consent,
    shippingAddress: addr,
  });
  if (!o.ok) throw new Error(o.reason);
  const paid = await markOrderPaid(db, { sellerId: seller.id, orderId: o.orderId, paymentMethod: "CARD" });
  if (!paid.ok) throw new Error(paid.reason);
  const items = await db.orderItem.findMany({ where: { orderId: o.orderId } });
  const boxItem = items.find((i) => i.optionId === boxOpt.id)!;
  const packItem = items.find((i) => i.optionId === packOpt.id)!;
  await db.queueItem.update({ where: { sellerId_orderItemId: { sellerId: seller.id, orderItemId: packItem.id } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  const order = await db.order.findUniqueOrThrow({ where: { id: o.orderId } });
  const scope = { sellerId: seller.id, buyerMemberId: buyer.id };
  return { seller, owner, ctx, buyer, order, boxItem, packItem, scope };
}
type S = Awaited<ReturnType<typeof setup>>;

const lv = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;
const request = (s: S, body: Record<string, unknown> = {}) => createRefundRequest(db, s.scope, s.order.id, { reason: "CHANGE_OF_MIND", ...body });
async function approve(s: S, id: string, fault: "BUYER" | "SELLER" = "BUYER") {
  const d = await getSellerRefundRequest(db, s.ctx, id);
  if (!d?.refundPreview) throw new Error(`preview ${d?.previewError}`);
  return approveRefundRequest(db, s.ctx, id, { expectedVersion: d.queueVersion!, expectedRefundAmount: d.refundPreview.byFault[fault].refundAmount, fault });
}

describe("구매자 환불 요청", () => {
  it("요청한 품목·수량으로 승인하면 그만큼만 환불되고 요청은 승인(이어진 환불 id), 주문은 결제 완료로 남는다", async () => {
    const s = await setup();
    const r = await request(s, { items: [{ orderItemId: s.packItem.id, quantity: 2 }] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.request).toMatchObject({ status: "REQUESTED", reason: "CHANGE_OF_MIND", reasonLabel: "단순 변심", items: [{ orderItemId: s.packItem.id, quantity: 2 }] });
    const list = await listSellerRefundRequests(db, s.ctx, { status: "REQUESTED" });
    expect(list.requests.map((x) => x.id)).toEqual([r.request.id]);
    expect(list.requests[0].orderNoLabel).toEqual(expect.stringMatching(/^\d{8}-\d{4,}$/));
    expect(list.counts).toEqual({ REQUESTED: 1 });
    const d = await getSellerRefundRequest(db, s.ctx, r.request.id);
    expect(d?.refundPreview).toMatchObject({ isFinal: false, byFault: { BUYER: { itemsAmount: 10000, refundAmount: 10000 } } });

    const a = await approve(s, r.request.id);
    if (!a.ok) throw new Error(a.reason);
    expect(a.request).toMatchObject({ status: "APPROVED", refundId: a.refund.refundId });
    expect(a.refund).toMatchObject({ refundAmount: 10000, isFinal: false });
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: s.packItem.id } })).refundedQuantity).toBe(2);
    expect((await db.order.findUniqueOrThrow({ where: { id: s.order.id } })).status).toBe("PAID");
    expect(await db.auditLog.count({ where: { action: "refund_request.approve", targetId: r.request.id } })).toBe(1);
    expect(await db.auditLog.count({ where: { action: "buyer_refund_request.create", targetId: r.request.id, actorId: s.buyer.id } })).toBe(1);
    // 다시 승인하거나 거절할 수 없다
    expect(await approveRefundRequest(db, s.ctx, r.request.id, { expectedVersion: await lv(s.seller.id), expectedRefundAmount: 10000, fault: "BUYER" })).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await rejectRefundRequest(db, s.ctx, r.request.id, { reason: "늦음" })).toEqual({ ok: false, reason: "invalid_transition" });
    // 구매자 화면: 남은 수량으로 다시 요청할 수 있다
    const c = await buyerRefundRequestContext(db, s.scope, s.order.id);
    expect(c).toMatchObject({ canRequest: true, blocked: null });
    expect(c?.items.find((i) => i.orderItemId === s.packItem.id)?.quantity).toBe(1);
  });

  it("거절은 사유가 있어야 하고(400) 로그 추적에 남으며, 거절 뒤 구매자는 다시 요청할 수 있다", async () => {
    const s = await setup();
    const r = await request(s);
    if (!r.ok) throw new Error(r.reason);
    for (const reason of [undefined, "", "   ", "가".repeat(201)]) {
      expect(await rejectRefundRequest(db, s.ctx, r.request.id, { reason }), String(reason)).toEqual({ ok: false, reason: "invalid_reject_reason" });
    }
    const rej = await rejectRefundRequest(db, s.ctx, r.request.id, { reason: "이미 포장을 마쳤습니다" });
    expect(rej).toMatchObject({ ok: true, request: { status: "REJECTED", rejectReason: "이미 포장을 마쳤습니다" } });
    expect(await db.auditLog.findFirst({ where: { action: "refund_request.reject", targetId: r.request.id } })).toMatchObject({ reason: "이미 포장을 마쳤습니다", actorId: s.owner.id });
    expect(await db.orderRefund.count()).toBe(0);
    expect((await request(s)).ok).toBe(true);
  });

  it("구매자는 요청 단계에서만 철회할 수 있고, 철회한 요청은 승인할 수 없다(환불 없음)", async () => {
    const s = await setup();
    const r = await request(s);
    if (!r.ok) throw new Error(r.reason);
    const d = await getSellerRefundRequest(db, s.ctx, r.request.id);
    expect(await cancelRefundRequest(db, s.scope, r.request.id)).toMatchObject({ ok: true, request: { status: "CANCELLED" } });
    expect(await cancelRefundRequest(db, s.scope, r.request.id)).toEqual({ ok: false, reason: "invalid_transition" });
    expect(
      await approveRefundRequest(db, s.ctx, r.request.id, { expectedVersion: d!.queueVersion!, expectedRefundAmount: d!.refundPreview!.byFault.BUYER.refundAmount, fault: "BUYER" }),
    ).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await db.orderRefund.count()).toBe(0);
  });

  it("요청 화면을 연 사이 구매자가 철회하면 승인은 환불까지 함께 되돌린다(같은 트랜잭션)", async () => {
    const s = await setup();
    const r = await request(s);
    if (!r.ok) throw new Error(r.reason);
    const d = await getSellerRefundRequest(db, s.ctx, r.request.id);
    // 승인 함수가 상태를 읽은 뒤 철회된 경우: refundOrder 안의 요청 잠금에서 걸린다
    await db.refundRequest.update({ where: { id: r.request.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const out = await refundOrder(db, s.ctx, s.order.id, {
      reason: "승인",
      expectedLiveVersion: d!.queueVersion!,
      fault: "BUYER",
      expectedRefundAmount: d!.refundPreview!.byFault.BUYER.refundAmount,
      refundRequestId: r.request.id,
    });
    expect(out).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await db.orderRefund.count()).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: s.order.id } })).status).toBe("PAID");
  });

  it("요청할 수 없는 경우: 발송한 주문·진행 중인 요청·남은 수량 초과·다른 주문 품목·「기타」 사유 설명 없음, 동시에 두 번 요청하면 하나만", async () => {
    const s = await setup();
    expect(await request(s, { items: [{ orderItemId: s.packItem.id, quantity: 4 }] })).toEqual({ ok: false, reason: "invalid_items" });
    const other = await setup();
    expect(await request(s, { items: [{ orderItemId: other.packItem.id, quantity: 1 }] })).toEqual({ ok: false, reason: "invalid_items" });
    expect(await request(s, { reason: "OTHER" })).toEqual({ ok: false, reason: "invalid_reason_text" });
    expect(await request(s, { reason: "NOPE" })).toEqual({ ok: false, reason: "invalid_reason" });
    const rs = await Promise.all([request(s), request(s), request(s)]);
    expect(rs.filter((x) => x.ok)).toHaveLength(1);
    expect(rs.filter((x) => !x.ok).map((x) => !x.ok && x.reason)).toEqual(["active_exists", "active_exists"]);
    expect(await db.refundRequest.count({ where: { orderId: s.order.id } })).toBe(1);

    await db.shipment.create({ data: { sellerId: other.seller.id, orderId: other.order.id, courier: "CJ", trackingNumber: "123456789012", shippedAt: new Date() } });
    expect(await request(other)).toEqual({ ok: false, reason: "not_refundable" });
    expect(await buyerRefundRequestContext(db, other.scope, other.order.id)).toMatchObject({ canRequest: false, blocked: "not_refundable" });
  });

  it("주문 화면에서 남은 품목을 모두 환불하면 진행 중인 요청은 승인으로 닫히고, 부분 환불이면 그대로 둔다", async () => {
    const s = await setup();
    const r = await request(s);
    if (!r.ok) throw new Error(r.reason);
    await db.queueItem.updateMany({ where: { orderId: s.order.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    const part = await refundOrder(db, s.ctx, s.order.id, { reason: "부분", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER", items: [{ orderItemId: s.boxItem.id, quantity: 1 }] });
    expect(part.ok).toBe(true);
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: r.request.id } })).status).toBe("REQUESTED");
    const rest = await refundOrder(db, s.ctx, s.order.id, { reason: "나머지", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER" });
    if (!rest.ok) throw new Error(rest.reason);
    expect(await db.refundRequest.findUniqueOrThrow({ where: { id: r.request.id } })).toMatchObject({ status: "APPROVED", refundId: rest.value.refundId });
    expect(await db.auditLog.count({ where: { action: "refund_request.close_on_refund", targetId: r.request.id } })).toBe(1);
  });

  it("판매자 격리: 다른 파트너스는 조회·승인·거절할 수 없고, 다른 구매자는 철회할 수 없다", async () => {
    const s = await setup();
    const other = await setup();
    const r = await request(s);
    if (!r.ok) throw new Error(r.reason);
    expect(await getSellerRefundRequest(db, other.ctx, r.request.id)).toBeNull();
    expect((await listSellerRefundRequests(db, other.ctx)).requests).toEqual([]);
    expect(await rejectRefundRequest(db, other.ctx, r.request.id, { reason: "x" })).toEqual({ ok: false, reason: "not_found" });
    expect(await approveRefundRequest(db, other.ctx, r.request.id, { expectedVersion: await lv(other.seller.id), expectedRefundAmount: 0 })).toEqual({ ok: false, reason: "not_found" });
    expect(await cancelRefundRequest(db, other.scope, r.request.id)).toEqual({ ok: false, reason: "not_found" });
    expect(await createRefundRequest(db, other.scope, s.order.id, { reason: "CHANGE_OF_MIND" })).toEqual({ ok: false, reason: "not_found" });
    expect((await db.refundRequest.findUniqueOrThrow({ where: { id: r.request.id } })).status).toBe("REQUESTED");
  });

  it("경로: 구매자 요청 201·해요체 거부 문구, 파트너스 상세·거절(합니다체)·승인(환불 결과)", async () => {
    const s = await setup();
    const bl = await loginBuyer(db, { sellerId: s.seller.id, loginId: s.buyer.loginId, password: PASSWORD }, {});
    const sl = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!bl.ok || !sl.ok) throw new Error("login");
    const buyerCookie = `lo_buyer=${bl.token}`;
    const sellerCookie = `lo_seller=${sl.token}`;
    const slugCtx = { params: Promise.resolve({ slug: s.seller.slug }) };
    const bad = await buyerPostRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/refund-requests`, { method: "POST", headers: { ...H, cookie: buyerCookie }, body: JSON.stringify({ orderId: s.order.id, reason: "OTHER" }) }),
      slugCtx,
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_reason_text", message: BUYER_REFUND_REQUEST_MESSAGES.invalid_reason_text });
    const ok = await buyerPostRoute(
      new Request(`http://localhost:3000/api/shop/${s.seller.slug}/refund-requests`, {
        method: "POST",
        headers: { ...H, cookie: buyerCookie },
        body: JSON.stringify({ orderId: s.order.id, reason: "DEFECTIVE", items: [{ orderItemId: s.packItem.id, quantity: 1 }] }),
      }),
      slugCtx,
    );
    expect(ok.status).toBe(201);
    const { request: created } = await ok.json();
    const got = await buyerGetRoute(new Request(`http://localhost:3000/api/shop/${s.seller.slug}/refund-requests?orderId=${s.order.id}`, { headers: { ...H, cookie: buyerCookie } }), slugCtx);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(await got.json()).toMatchObject({ canRequest: false, blocked: "active_exists", requests: [{ id: created.id, status: "REQUESTED" }] });

    const idCtx = { params: Promise.resolve({ id: created.id }) };
    const detail = await sellerDetailRoute(new Request(`http://localhost:3000/api/seller/refund-requests/${created.id}`, { headers: { ...H, cookie: sellerCookie } }), idCtx);
    expect(detail.status).toBe(200);
    const d = await detail.json();
    expect(d.orderNoLabel).toEqual(expect.stringMatching(/^\d{8}-\d{4,}$/));
    const noReason = await rejectRoute(new Request(`http://localhost:3000/api/seller/refund-requests/${created.id}/reject`, { method: "POST", headers: { ...H, cookie: sellerCookie }, body: "{}" }), idCtx);
    expect(noReason.status).toBe(400);
    expect(await noReason.json()).toEqual({ error: "invalid_reject_reason", message: SELLER_REFUND_REQUEST_MESSAGES.invalid_reject_reason });
    const ap = await approveRoute(
      new Request(`http://localhost:3000/api/seller/refund-requests/${created.id}/approve`, {
        method: "POST",
        headers: { ...H, cookie: sellerCookie },
        body: JSON.stringify({ expectedVersion: d.queueVersion, expectedRefundAmount: d.refundPreview.byFault.SELLER.refundAmount, fault: "SELLER" }),
      }),
      idCtx,
    );
    expect(ap.status).toBe(200);
    expect(await ap.json()).toMatchObject({ request: { status: "APPROVED" }, refund: { refundAmount: 5000, isFinal: false } });
    const again = await approveRoute(
      new Request(`http://localhost:3000/api/seller/refund-requests/${created.id}/approve`, {
        method: "POST",
        headers: { ...H, cookie: sellerCookie },
        body: JSON.stringify({ expectedVersion: await lv(s.seller.id), expectedRefundAmount: 0, fault: "SELLER" }),
      }),
      idCtx,
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "invalid_transition", message: SELLER_REFUND_REQUEST_MESSAGES.invalid_transition });
  });
});
