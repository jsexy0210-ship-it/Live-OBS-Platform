import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as detailRoute } from "../../app/api/seller/orders/[orderId]/route";
import { GET as imageRoute } from "../../app/api/seller/orders/[orderId]/items/[itemId]/image/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { getOrder, getOrderItemImage } from "../../lib/server/orders/read";
import { setProductThumbnail, uploadProductImage } from "../../lib/server/products/images";
import type { TenantContext } from "../../lib/server/tenant/context";
import { png } from "../unit/shopContentFixtures";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => { await db.$disconnect(); await prisma.$disconnect(); });

async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const buyer = await createBuyer(seller.id, grade.id);
  const paid = await createPaidOrderItem(seller.id, buyer.id);
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, owner, buyer, ctx, ...paid };
}
async function cookie(email: string) {
  const result = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!result.ok) throw new Error(result.reason);
  return `lo_seller=${result.token}`;
}
function imageRequest(orderId: string, itemId: string, auth = "") {
  return new Request(`http://localhost:3000/api/seller/orders/${orderId}/items/${itemId}/image`, { headers: { cookie: auth } });
}
function imageParams(orderId: string, itemId: string) { return { params: Promise.resolve({ orderId, itemId }) }; }
async function queue(s: Awaited<ReturnType<typeof setup>>, position: number, sessionId: string | null = null) {
  return db.queueItem.create({ data: { sellerId: s.seller.id, orderId: s.order.id, orderItemId: s.item.id,
    broadcastSessionId: sessionId, position, receivedAt: new Date("2026-10-06T00:00:00Z"), nicknameSnapshot: "닉", productLabel: "상품", quantity: 1 } });
}

describe("SA022 읽기 상세 계약", () => {
  it("주문 소속 기록만 반환하고 순번은 같은 방송의 실제 앞 대기 수로 계산한다", async () => {
    const s = await setup();
    const live = await db.broadcastSession.create({ data: { sellerId: s.seller.id, title: "현재 방송" } });
    const q = await queue(s, 20, live.id);
    const preceding = await createPaidOrderItem(s.seller.id, s.buyer.id);
    await queue({ ...s, ...preceding }, 2, live.id);
    const outside = await createPaidOrderItem(s.seller.id, s.buyer.id);
    await queue({ ...s, ...outside }, 1); // 방송 전 대기는 다른 그룹
    const foreign = await setup();
    await queue(foreign, 1);
    await db.payment.create({ data: { sellerId: s.seller.id, orderId: s.order.id, provider: "fake", method: "CARD", status: "PAID", amount: 5000,
      pgTid: "approval-reference", cardName: "테스트카드", cardLast4: "1234", cardInstallment: 0, approvedAt: new Date(), failureCode: "PRIVATE-PAYMENT" } });
    const receipt = await db.orderReceiptRequest.create({ data: { sellerId: s.seller.id, orderId: s.order.id, buyerMemberId: s.buyer.id,
      kind: "TAX_INVOICE", identitySealed: "PRIVATE-SEALED", identityLast4: "5678", taxInfo: { email: "PRIVATE-TAX" } } });
    await db.receiptIssue.create({ data: { sellerId: s.seller.id, requestId: receipt.id, amount: 5000, status: "ISSUED", providerKey: "PRIVATE-RECEIPT", issuedAt: new Date() } });
    await db.orderConsent.create({ data: { sellerId: s.seller.id, orderId: s.order.id, kind: "OPENED_NO_REFUND", noticeVersion: "v1", agreedAt: new Date() } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, queueItemId: q.id, nicknameSnapshot: "닉", cardName: "연결 HIT", grade: "SR", note: "PRIVATE-HIT-NOTE" } });
    await db.hitCard.create({ data: { sellerId: s.seller.id, buyerMemberId: s.buyer.id, nicknameSnapshot: "닉", cardName: "주문에 연결 안 된 HIT" } });
    await db.orderNotification.create({ data: { sellerId: s.seller.id, orderId: s.order.id, kind: "PAYMENT_DUE_SOON", status: "FAILED", claimedAt: new Date(), failureReason: "PRIVATE-NOTIFICATION" } });
    await db.mailDelivery.create({ data: { sellerId: s.seller.id, kind: "order.paid", refId: s.order.id, month: "2026-10", status: "SENT", finishedAt: new Date(), providerMessageId: "PRIVATE-MAIL" } });
    await db.mailDelivery.create({ data: { sellerId: foreign.seller.id, kind: "order.paid", refId: s.order.id, month: "2026-10", status: "SENT" } });
    await db.mailDelivery.create({ data: { sellerId: s.seller.id, kind: "password_reset", refId: s.order.id, month: "2026-10", status: "SENT" } });
    const view = await getOrder(db, s.ctx, s.order.id);
    expect(view.items[0].queue).toMatchObject({ id: q.id, status: "WAITING", position: 20, aheadCount: 1, waitingNumber: 2, broadcastSession: { title: "현재 방송" } });
    expect(view.payments[0]).toMatchObject({ status: "PAID", cardLast4: "1234", pgTid: "approval-reference" });
    expect(view.receiptRequests[0].issues[0]).toMatchObject({ status: "ISSUED", amount: 5000 });
    expect(view.consents).toHaveLength(1);
    expect(view.hitCards).toHaveLength(1);
    expect(view.hitCards[0].note).toBe("PRIVATE-HIT-NOTE");
    expect(view.notifications).toHaveLength(2);
    expect(view.notifications.find((n) => n.source === "MAIL_DELIVERY")).toMatchObject({ channel: "EMAIL", status: "SENT", sentAt: expect.any(Date) });
    expect(view.notifications.find((n) => n.source === "ORDER_NOTIFICATION")).toMatchObject({ channel: null, status: "FAILED" });
    const serialized = JSON.stringify(view);
    for (const marker of ["PRIVATE-PAYMENT", "PRIVATE-SEALED", "PRIVATE-TAX", "PRIVATE-RECEIPT", "PRIVATE-NOTIFICATION", "PRIVATE-MAIL"]) expect(serialized).not.toContain(marker);
  });

  it("원천이 없으면 이미지/주문대기는 null이고 이력은 빈 배열이다", async () => {
    const s = await setup();
    const view = await getOrder(db, s.ctx, s.order.id);
    expect(view.items[0]).toMatchObject({ imageUrl: null, queue: null, shipQuantity: 1 });
    expect(view.notifications).toEqual([]);
    expect(view.hitCards).toEqual([]);
    expect(view.payments).toEqual([]);
    expect(view.receiptRequests).toEqual([]);
  });

  it("PII 비권한/마스터 주문 대리조회는 실명·연락처·HIT 메모를 반환하지 않는다", async () => {
    const s = await setup();
    const q = await queue(s, 1);
    await db.hitCard.create({ data: { sellerId: s.seller.id, queueItemId: q.id, nicknameSnapshot: "닉", cardName: "HIT", note: "PRIVATE-HIT-NOTE" } });
    for (const ctx of [
      { ...s.ctx, isOwner: false, permissions: ["ORDER_SHIPPING"] } as TenantContext,
      { ...s.ctx, actorType: "PLATFORM_ADMIN", isOwner: false, readOnly: true, impersonationScopes: ["ORDERS"] } as TenantContext,
    ]) {
      const view = await getOrder(db, ctx, s.order.id);
      expect(view.buyer).not.toHaveProperty("name");
      expect(view.buyer).not.toHaveProperty("phone");
      expect(view.hitCards[0]).not.toHaveProperty("note");
      expect(JSON.stringify(view)).not.toContain("PRIVATE-HIT-NOTE");
    }
    expect(await db.auditLog.count({ where: { action: "customer.pii.view" } })).toBe(0);
    await expect(getOrder(db, { ...s.ctx, isOwner: false }, s.order.id)).rejects.toMatchObject({ status: 403 });
    await expect(getOrder(db, { ...s.ctx, actorType: "PLATFORM_ADMIN", isOwner: false, readOnly: true, impersonationScopes: ["MEMBERS"] }, s.order.id)).rejects.toMatchObject({ status: 403 });
    const other = await setup();
    await expect(getOrder(db, other.ctx, s.order.id)).rejects.toMatchObject({ status: 404 });
    await db.order.update({ where: { id: s.order.id }, data: { legalHoldAt: new Date() } });
    await expect(getOrder(db, s.ctx, s.order.id)).rejects.toMatchObject({ status: 404 });
  });

  it("배송 직원은 숨김 상품·폐점/구독잠금/정지 중에도 주문 소속 지정 썸네일을 읽는다", async () => {
    const s = await setup();
    const first = await uploadProductImage(db, s.ctx, s.product.id, png(200, 150, [1, 1, 1]));
    const bytes = png(200, 150, [2, 2, 2]);
    const second = await uploadProductImage(db, s.ctx, s.product.id, bytes);
    if (!first.ok || !second.ok) throw new Error("upload failed");
    await setProductThumbnail(db, s.ctx, s.product.id, { imageId: second.image.id });
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const auth = await cookie(staff.email);
    await db.product.update({ where: { id: s.product.id }, data: { status: "DRAFT" } });
    await db.seller.update({ where: { id: s.seller.id }, data: { operatingState: "PAUSED", trialEndsAt: new Date("2020-01-01"), status: "SUSPENDED" } });
    const response = await imageRoute(imageRequest(s.order.id, s.item.id, auth), imageParams(s.order.id, s.item.id));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    const view = await getOrder(db, { ...s.ctx, isOwner: false, permissions: ["ORDER_SHIPPING"] }, s.order.id);
    expect(view.items[0].imageUrl).toBe(`/api/seller/orders/${s.order.id}/items/${s.item.id}/image`);
  });

  it("이미지 조회는 인증/권한/주문-품목 소속/테넌트/분리보관/삭제 경계를 지킨다", async () => {
    const s = await setup();
    const other = await setup();
    const auth = await cookie(s.owner.email);
    expect((await imageRoute(imageRequest(s.order.id, s.item.id), imageParams(s.order.id, s.item.id))).status).toBe(401);
    const caster = await createSellerUser(s.seller.id, "BROADCASTER");
    expect((await imageRoute(imageRequest(s.order.id, s.item.id, await cookie(caster.email)), imageParams(s.order.id, s.item.id))).status).toBe(403);
    for (const [orderId, itemId] of [[s.order.id, other.item.id], [other.order.id, other.item.id], ["bad", s.item.id]]) {
      const response = await imageRoute(imageRequest(orderId, itemId, auth), imageParams(orderId, itemId));
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    const another = await createPaidOrderItem(s.seller.id, s.buyer.id);
    await expect(getOrderItemImage(db, s.ctx, s.order.id, another.item.id)).rejects.toMatchObject({ status: 404 });
    expect(await getOrderItemImage(db, s.ctx, s.order.id, s.item.id)).toBeNull();
    await db.order.update({ where: { id: s.order.id }, data: { legalHoldAt: new Date() } });
    await expect(getOrderItemImage(db, s.ctx, s.order.id, s.item.id)).rejects.toMatchObject({ status: 404 });
    await db.order.update({ where: { id: s.order.id }, data: { legalHoldAt: null } });
    await db.product.update({ where: { id: s.product.id }, data: { deletedAt: new Date() } });
    await expect(getOrderItemImage(db, s.ctx, s.order.id, s.item.id)).rejects.toMatchObject({ status: 404 });
  });

  it("상세 HTTP 응답은 성공/오류 모두 no-store이며 조회로 주문·결제를 바꾸지 않는다", async () => {
    const s = await setup();
    const auth = await cookie(s.owner.email);
    const before = await db.order.findUniqueOrThrow({ where: { id: s.order.id } });
    const response = await detailRoute(new Request(`http://localhost:3000/api/seller/orders/${s.order.id}`, { headers: { cookie: auth } }), { params: Promise.resolve({ orderId: s.order.id }) });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await db.order.findUniqueOrThrow({ where: { id: s.order.id } })).toEqual(before);
    expect(await db.payment.count()).toBe(0);
    const missing = await detailRoute(new Request("http://localhost:3000/api/seller/orders/bad", { headers: { cookie: auth } }), { params: Promise.resolve({ orderId: "bad" }) });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("cache-control")).toContain("no-store");
  });
});
