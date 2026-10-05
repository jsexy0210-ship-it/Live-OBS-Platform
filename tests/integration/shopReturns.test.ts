import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as buyerImagePost } from "../../app/api/shop/[slug]/returns/images/route";
import { POST as buyerCreatePost } from "../../app/api/shop/[slug]/returns/route";
import { GET as sellerListGet } from "../../app/api/seller/returns/route";
import { loginBuyer, loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { OPENED_NO_REFUND_CONSENT } from "../../lib/server/orders/consent";
import { createOrder } from "../../lib/server/orders/create";
import { autoConfirmPurchases, completeDelivery } from "../../lib/server/orders/delivery";
import { shipOrder } from "../../lib/server/orders/ship";
import { hasImageMetadata } from "../../lib/server/product-reviews/image";
import { markOrderPaid, refundOrder } from "../../lib/server/queue/service";
import {
  acceptReturn,
  buyerCancelReturn,
  buyerReturnContext,
  buyerReturnImage,
  buyerShipBack,
  convertExchangeToRefund,
  createReturn,
  getSellerReturn,
  holdExchange,
  inspectReturn,
  listSellerReturns,
  receiveReturn,
  refundReturn,
  rejectInspectedReturn,
  rejectReturn,
  sellerReturnImage,
  shipExchange,
  uploadReturnImage,
} from "../../lib/server/shop-returns/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { GPS_EXIF, jpeg } from "../unit/productImageFormatsFixtures";
import { PASSWORD, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 교환·반품(SA-029 · SH-022-R): 신청 자격(배송 완료·구매 확정 전·본인)·중복 신청(동시)·상태 전이·재고 복구/교환 재고 차감·반품 환불 연결·
// 자동 구매 확정 보류·직접 환불 시 신청 닫기·권한·판매자 격리·사진·탈퇴.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const consent = { agreed: true, noticeVersion: OPENED_NO_REFUND_CONSENT.version };
const addr = { recipientName: "김구매", phone: "010-1234-5678", zipCode: "06236", address1: "주소 1" };
const DAY = 24 * 60 * 60 * 1000;
const H = { host: "localhost:3000", origin: "http://localhost:3000" };

// 상품 A(5,000원 × 2) + 상품 B(3,000원 × 1) = 13,000원 + 배송비 3,000원
async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  const other = await createLoginBuyer(seller.id, grade.id);
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const pa = await db.product.create({ data: { sellerId: seller.id, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const oa = await db.productOption.create({ data: { sellerId: seller.id, productId: pa.id, name: "1박스", stock: 50 } });
  const pb = await db.product.create({ data: { sellerId: seller.id, name: "슬리브", price: 3000, status: "ON_SALE" } });
  const ob = await db.productOption.create({ data: { sellerId: seller.id, productId: pb.id, name: "블랙", stock: 5 } });
  const scope = { sellerId: seller.id, buyerMemberId: buyer.id };
  const delivered = async (member = buyer) => {
    const r = await createOrder(db, { sellerId: seller.id, buyerMemberId: member.id, items: [{ optionId: oa.id, quantity: 2 }, { optionId: ob.id, quantity: 1 }], consent, shippingAddress: addr });
    if (!r.ok) throw new Error(r.reason);
    await markOrderPaid(db, { sellerId: seller.id, orderId: r.orderId, paymentMethod: "CARD" });
    const s = await shipOrder(db, ctx, r.orderId, { courier: "CJ", trackingNumber: "123456789012" });
    if (!s.ok) throw new Error(s.reason);
    await completeDelivery(db, ctx, r.orderId);
    return r.orderId;
  };
  const items = (orderId: string) => db.orderItem.findMany({ where: { orderId }, orderBy: { productNameSnapshot: "asc" } });
  const ret = async (orderId: string, extra: Record<string, unknown> = {}) => {
    const r = await createReturn(db, scope, orderId, { orderId, kind: "RETURN", reason: "DEFECTIVE", reasonText: "박스가 찢어져 왔어요", ...extra });
    if (!r.ok) throw new Error(r.reason);
    return r.request;
  };
  const exch = async (orderId: string, itemIds: string[]) => {
    const r = await createReturn(db, scope, orderId, { orderId, kind: "EXCHANGE", reason: "DEFECTIVE", orderItemIds: itemIds });
    if (!r.ok) throw new Error(r.reason);
    return r.request;
  };
  return { seller, grade, buyer, other, owner, ctx, scope, oa, ob, delivered, items, ret, exch };
}
const stock = async (optionId: string) => (await db.productOption.findUniqueOrThrow({ where: { id: optionId } })).stock;
const lv = async (sellerId: string) => (await db.seller.findUniqueOrThrow({ where: { id: sellerId } })).liveVersion;
const status = async (id: string) => (await db.returnRequest.findUniqueOrThrow({ where: { id } })).status;
const proceedToReceived = async (s: Awaited<ReturnType<typeof shop>>, id: string, restock = false) => {
  expect(await acceptReturn(db, s.ctx, id, {})).toMatchObject({ ok: true });
  expect(await receiveReturn(db, s.ctx, id, {})).toMatchObject({ ok: true });
  expect(await inspectReturn(db, s.ctx, id, { result: "OK", restock })).toMatchObject({ ok: true });
};

describe("신청 자격", () => {
  it("배송 완료된 본인 주문만 신청할 수 있고, 발송 전·남의 주문·구매 확정·환불된 주문은 막는다", async () => {
    const s = await shop();
    // 발송 전 결제 완료 주문
    const r = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: s.oa.id, quantity: 1 }], consent, shippingAddress: addr });
    if (!r.ok) throw new Error(r.reason);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: r.orderId, paymentMethod: "CARD" });
    expect(await createReturn(db, s.scope, r.orderId, { orderId: r.orderId, kind: "RETURN", reason: "DEFECTIVE" })).toEqual({ ok: false, reason: "not_returnable" });
    const id = await s.delivered();
    // 남의 주문은 없는 주문
    expect(await createReturn(db, { sellerId: s.seller.id, buyerMemberId: s.other.id }, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE" })).toEqual({ ok: false, reason: "not_found" });
    expect(await buyerReturnContext(db, { sellerId: s.seller.id, buyerMemberId: s.other.id }, id)).toBeNull();
    // 구매 확정한 주문
    await db.order.update({ where: { id }, data: { purchaseConfirmedAt: new Date() } });
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE" })).toEqual({ ok: false, reason: "not_returnable" });
    expect(await buyerReturnContext(db, s.scope, id)).toMatchObject({ canRequest: false, blocked: "not_returnable" });
    await db.order.update({ where: { id }, data: { purchaseConfirmedAt: null } });
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE" })).toMatchObject({ ok: true });
    // 환불된 주문
    const id2 = await s.delivered();
    expect(await refundOrder(db, s.ctx, id2, { reason: "요청", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER" })).toMatchObject({ ok: true });
    expect(await createReturn(db, s.scope, id2, { orderId: id2, kind: "RETURN", reason: "DEFECTIVE" })).toEqual({ ok: false, reason: "not_returnable" });
  });

  it("입력 반례: 사유 없음·기타인데 설명 없음·교환인데 품목 없음/남의 주문 품목/중복·잘못된 사진", async () => {
    const s = await shop();
    const id = await s.delivered();
    const other = await s.delivered(s.other);
    const otherItems = await s.items(other);
    const mine = await s.items(id);
    const bad = async (extra: Record<string, unknown>) => (await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", ...extra }) as { reason: string }).reason;
    expect(await bad({ kind: "SWAP" })).toBe("invalid_kind");
    expect(await bad({ reason: "BORED" })).toBe("invalid_reason");
    expect(await bad({ reason: "OTHER", reasonText: "" })).toBe("invalid_reason_text");
    expect(await bad({ reasonText: "가".repeat(501) })).toBe("invalid_reason_text");
    expect(await bad({ kind: "EXCHANGE" })).toBe("invalid_items");
    expect(await bad({ kind: "EXCHANGE", orderItemIds: [] })).toBe("invalid_items");
    expect(await bad({ kind: "EXCHANGE", orderItemIds: [mine[0].id, mine[0].id] })).toBe("invalid_items");
    expect(await bad({ kind: "EXCHANGE", orderItemIds: [otherItems[0].id] })).toBe("invalid_items");
    expect(await bad({ imageIds: ["not-a-uuid"] })).toBe("invalid_images");
    expect(await bad({ imageIds: ["00000000-0000-4000-8000-000000000000"] })).toBe("invalid_images");
    expect(await db.returnRequest.count()).toBe(0);
  });

  it("DB가 막는다: 같은 주문에 진행 중인 신청을 직접 두 건 넣을 수 없고, 상태와 시각이 어긋난 행도 넣을 수 없다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const base = { sellerId: s.seller.id, orderId: id, buyerMemberId: s.buyer.id, kind: "RETURN" as const, reason: "DEFECTIVE" as const };
    await db.returnRequest.create({ data: base });
    await expect(db.returnRequest.create({ data: base })).rejects.toThrow();
    await expect(db.returnRequest.create({ data: { ...base, status: "CANCELLED" } })).rejects.toThrow(); // 철회 시각 없음
    await expect(db.returnRequest.create({ data: { ...base, status: "ACCEPTED", acceptedAt: new Date() } })).rejects.toThrow(); // 사유 주체 없음
    await db.returnRequest.create({ data: { ...base, status: "CANCELLED", cancelledAt: new Date() } }); // 닫힌 신청은 여러 건 가능
  });

  it("진행 중인 신청은 주문당 1건: 두 번째와 동시 신청은 한 건만 만들어진다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const results = await Promise.all([1, 2, 3].map(() => createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE" })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "active_exists")).toBe(true);
    expect(await db.returnRequest.count({ where: { orderId: id } })).toBe(1);
    expect(await buyerReturnContext(db, s.scope, id)).toMatchObject({ canRequest: false, blocked: "active_exists" });
  });
});

describe("처리 흐름과 상태 전이", () => {
  it("신청 → 접수 → 회수 완료 순서만 가능하고 단계를 건너뛰거나 되풀이하면 막는다(DB는 로그 추적 기록)", async () => {
    const s = await shop();
    const id = await s.delivered();
    const req = await s.ret(id);
    expect(await receiveReturn(db, s.ctx, req.id, {})).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await shipExchange(db, s.ctx, req.id, { courier: "CJ", trackingNumber: "1234567890" })).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await refundReturn(db, s.ctx, req.id, { expectedVersion: await lv(s.seller.id), expectedRefundAmount: 16000 })).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await acceptReturn(db, s.ctx, req.id, { fault: "NOBODY" })).toEqual({ ok: false, reason: "invalid_fault" });
    expect(await acceptReturn(db, s.ctx, req.id, {})).toMatchObject({ ok: true, request: { status: "ACCEPTED", fault: "SELLER" } });
    expect(await acceptReturn(db, s.ctx, req.id, {})).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await rejectReturn(db, s.ctx, req.id, { reason: "안 됩니다" })).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await receiveReturn(db, s.ctx, req.id, {})).toMatchObject({ ok: true, request: { status: "RECEIVED" } });
    expect(await receiveReturn(db, s.ctx, req.id, {})).toEqual({ ok: false, reason: "invalid_transition" });
    expect(await buyerCancelReturn(db, s.scope, req.id)).toEqual({ ok: false, reason: "invalid_transition" });
    expect((await db.auditLog.findMany({ where: { targetId: req.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action)).toEqual(["buyer_return.create", "return.accept", "return.receive"]);
  });

  it("사유가 「기타」면 접수할 때 사유 주체를 꼭 정해야 하고, 단순 변심은 구매자 사정이 기본이다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const req = await s.ret(id, { reason: "OTHER", reasonText: "그냥" });
    expect(await acceptReturn(db, s.ctx, req.id, {})).toEqual({ ok: false, reason: "fault_required" });
    expect(await status(req.id)).toBe("REQUESTED");
    expect(await acceptReturn(db, s.ctx, req.id, { fault: "BUYER" })).toMatchObject({ ok: true, request: { fault: "BUYER" } });
    const id2 = await s.delivered();
    expect(await buyerCancelReturn(db, s.scope, req.id)).toMatchObject({ ok: true });
    const mind = await s.ret(id2, { reason: "CHANGE_OF_MIND" });
    expect(await acceptReturn(db, s.ctx, mind.id, {})).toMatchObject({ ok: true, request: { fault: "BUYER" } });
  });

  it("거절은 사유가 필수이고 신청 단계만 되며, 거절·철회 뒤에는 다시 신청할 수 있다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const req = await s.ret(id);
    expect(await rejectReturn(db, s.ctx, req.id, { reason: "  " })).toEqual({ ok: false, reason: "invalid_reject_reason" });
    expect(await rejectReturn(db, s.ctx, req.id, { reason: "사용 흔적이 있습니다" })).toMatchObject({ ok: true, request: { status: "REJECTED", rejectReason: "사용 흔적이 있습니다" } });
    const again = await s.ret(id);
    expect(await buyerCancelReturn(db, { sellerId: s.seller.id, buyerMemberId: s.other.id }, again.id)).toEqual({ ok: false, reason: "not_found" });
    expect(await buyerCancelReturn(db, s.scope, again.id)).toMatchObject({ ok: true, request: { status: "CANCELLED" } });
    expect(await s.ret(id)).toMatchObject({ status: "REQUESTED" });
    expect(await db.returnRequest.count({ where: { orderId: id } })).toBe(3);
  });

  it("구매자는 접수 단계에서 돌려보낸 송장을 남길 수 있다(신청 단계·남의 신청은 막음)", async () => {
    const s = await shop();
    const id = await s.delivered();
    const req = await s.ret(id);
    expect(await buyerShipBack(db, s.scope, req.id, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "invalid_transition" });
    await acceptReturn(db, s.ctx, req.id, {});
    expect(await buyerShipBack(db, s.scope, req.id, { courier: "XX", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "invalid_courier" });
    expect(await buyerShipBack(db, s.scope, req.id, { courier: "CJ", trackingNumber: "한글" })).toEqual({ ok: false, reason: "invalid_tracking" });
    expect(await buyerShipBack(db, { sellerId: s.seller.id, buyerMemberId: s.other.id }, req.id, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "not_found" });
    expect(await buyerShipBack(db, s.scope, req.id, { courier: "CJ", trackingNumber: "123456789012" })).toMatchObject({ ok: true, request: { returnCourier: "CJ", returnCourierName: "CJ대한통운" } });
  });
});

describe("재고", () => {
  it("검수 이상 없음에서 재고 되돌리기를 고르면 한 번만 되돌리고, 안 고르면 그대로이며, 뒤이은 환불이 다시 되돌리지 않는다", async () => {
    const s = await shop();
    const before = [await stock(s.oa.id), await stock(s.ob.id)];
    const id = await s.delivered();
    const mid = [await stock(s.oa.id), await stock(s.ob.id)];
    expect(mid).toEqual([before[0] - 2, before[1] - 1]);
    const keep = await s.ret(id);
    await proceedToReceived(s, keep.id, false);
    expect([await stock(s.oa.id), await stock(s.ob.id)]).toEqual(mid);
    expect(await db.returnRequest.findUniqueOrThrow({ where: { id: keep.id } })).toMatchObject({ restocked: false });
    const id2 = await s.delivered();
    const mid2 = [await stock(s.oa.id), await stock(s.ob.id)];
    const req = await s.ret(id2);
    await proceedToReceived(s, req.id, true);
    expect([await stock(s.oa.id), await stock(s.ob.id)]).toEqual([mid2[0] + 2, mid2[1] + 1]);
    expect(await db.returnRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ restocked: true });
    expect(await db.stockMovement.count({ where: { orderId: id2, reason: "REFUND" } })).toBe(2);
    // 환불(발송 후라 기존 환불은 재고를 되돌리지 않는다)해도 두 번 되돌리지 않는다
    const prev = await shopPreview(s, req.id);
    expect(await refundReturn(db, s.ctx, req.id, { expectedVersion: prev.queueVersion, expectedRefundAmount: prev.amount })).toMatchObject({ ok: true });
    expect([await stock(s.oa.id), await stock(s.ob.id)]).toEqual([mid2[0] + 2, mid2[1] + 1]);
  });

  it("판매자 설정에서 취소·반품 재고 복구를 끄면 되돌리지 않는다", async () => {
    const s = await shop();
    await db.sellerOrderPolicy.create({ data: { sellerId: s.seller.id, restockOnCancel: false } });
    const id = await s.delivered();
    const at = await stock(s.oa.id);
    const req = await s.ret(id);
    await proceedToReceived(s, req.id, true);
    expect(await stock(s.oa.id)).toBe(at);
    expect(await db.returnRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ restocked: false });
  });

  it("재고는 입고 확인에서 되돌리지 않고 검수 이상 없음 뒤에만 되돌린다. 되돌린 뒤에는 문제 있음으로 바꿀 수 없고, 문제 있음 거절은 재고를 늘리지 않는다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const at = [await stock(s.oa.id), await stock(s.ob.id)];
    const req = await s.ret(id);
    await acceptReturn(db, s.ctx, req.id, {});
    // restock을 보내도 입고 확인은 재고를 건드리지 않는다
    await receiveReturn(db, s.ctx, req.id, { restock: true });
    expect([await stock(s.oa.id), await stock(s.ob.id)]).toEqual(at);
    // 문제 있음 검수는 restock을 보내도 되돌리지 않고, 반송·거절 뒤에도 재고는 처음 값
    expect(await inspectReturn(db, s.ctx, req.id, { result: "USED_DAMAGED", restock: true })).toMatchObject({ ok: true, request: { restocked: false } });
    expect(await rejectInspectedReturn(db, s.ctx, req.id, { reason: "봉인 훼손" })).toMatchObject({ ok: true });
    expect([await stock(s.oa.id), await stock(s.ob.id)]).toEqual(at);
    expect(await db.stockMovement.count({ where: { orderId: id, reason: "REFUND" } })).toBe(0);
    // 이상 없음 + 되돌리기 뒤에는 검수를 문제 있음으로 바꿀 수 없다
    const id2 = await s.delivered();
    const mid = [await stock(s.oa.id), await stock(s.ob.id)];
    const r2 = await s.ret(id2);
    await proceedToReceived(s, r2.id, true);
    expect([await stock(s.oa.id), await stock(s.ob.id)]).toEqual([mid[0] + 2, mid[1] + 1]);
    expect(await inspectReturn(db, s.ctx, r2.id, { result: "MISSING_PARTS" })).toEqual({ ok: false, reason: "inspection_locked" });
    expect(await inspectReturn(db, s.ctx, r2.id, { result: "OK", restock: true })).toMatchObject({ ok: true });
    expect([await stock(s.oa.id), await stock(s.ob.id)]).toEqual([mid[0] + 2, mid[1] + 1]);
  });

  it("교환 발송은 교환 품목의 재고를 빼고, 재고가 모자라면 아무것도 바꾸지 않는다", async () => {
    const s = await shop();
    const id = await s.delivered();
    // 부스터 팩(2개), 슬리브(1개). 정렬은 DB 문자 정렬 규칙에 따라 달라지므로 옵션으로 고른다
    const all = await s.items(id);
    const a = all.find((i) => i.optionId === s.oa.id)!;
    const b = all.find((i) => i.optionId === s.ob.id)!;
    const req = await s.exch(id, [a.id]);
    await proceedToReceived(s, req.id);
    const at = await stock(s.oa.id);
    // 재고를 1개로 줄이면 2개 교환은 막힌다
    await db.productOption.update({ where: { id: s.oa.id }, data: { stock: 1 } });
    const moves = await db.stockMovement.count();
    expect(await shipExchange(db, s.ctx, req.id, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "insufficient_stock" });
    expect(await stock(s.oa.id)).toBe(1);
    expect(await db.stockMovement.count()).toBe(moves);
    expect(await status(req.id)).toBe("RECEIVED");
    await db.productOption.update({ where: { id: s.oa.id }, data: { stock: at } });
    expect(await shipExchange(db, s.ctx, req.id, { courier: "", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "invalid_courier" });
    expect(await shipExchange(db, s.ctx, req.id, { courier: "CJ", trackingNumber: "123456789012" })).toMatchObject({ ok: true, request: { status: "COMPLETED", exchangeTrackingNumber: "123456789012" } });
    expect(await stock(s.oa.id)).toBe(at - 2);
    expect(await stock(s.ob.id)).toBe(4);
    expect(await db.stockMovement.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { reason: "EXCHANGE" } })).toMatchObject({ optionId: s.oa.id, delta: -2, orderId: id });
    expect(await shipExchange(db, s.ctx, req.id, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "invalid_transition" });
    // 완료한 교환 뒤에는 같은 주문에 다시 신청할 수 있다
    expect(await s.exch(id, [b.id])).toMatchObject({ status: "REQUESTED", kind: "EXCHANGE" });
  });

  it("교환 발송 뒤 같은 주문을 반품으로 회수하면 교환으로 나간 재고를 다시 되돌릴 수 있다(회수 때 한 번 되돌린 품목도)", async () => {
    const s = await shop();
    const id = await s.delivered();
    const a = (await s.items(id)).find((i) => i.optionId === s.oa.id)!;
    const start = await stock(s.oa.id);
    const ex = await s.exch(id, [a.id]);
    await proceedToReceived(s, ex.id, true); // 회수 때 재고를 되돌림(+2)
    expect(await stock(s.oa.id)).toBe(start + 2);
    expect(await shipExchange(db, s.ctx, ex.id, { courier: "CJ", trackingNumber: "123456789012" })).toMatchObject({ ok: true }); // 교환 발송(-2)
    expect(await stock(s.oa.id)).toBe(start);
    // 이어서 반품 신청 → 회수 완료에서 재고 되돌리기: 교환으로 나간 만큼 다시 +2
    const ret = await s.ret(id);
    await proceedToReceived(s, ret.id, true);
    expect(await stock(s.oa.id)).toBe(start + 2);
    expect(await stock(s.ob.id)).toBe(5); // 슬리브(교환하지 않은 품목)는 반품 회수로 +1: 주문 때 4 → 5
  });

  it("반품 신청에는 교환 발송을 못 하고, 교환 신청에는 반품 환불을 못 한다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const ret = await s.ret(id);
    await proceedToReceived(s, ret.id);
    expect(await shipExchange(db, s.ctx, ret.id, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "wrong_kind" });
    const id2 = await s.delivered();
    const ex = await s.exch(id2, [(await s.items(id2))[0].id]);
    await proceedToReceived(s, ex.id);
    expect(await refundReturn(db, s.ctx, ex.id, { expectedVersion: await lv(s.seller.id), expectedRefundAmount: 1 })).toEqual({ ok: false, reason: "wrong_kind" });
  });
});

// 환불 미리보기에서 사유 주체별 금액과 버전을 읽는다
async function shopPreview(s: Awaited<ReturnType<typeof shop>>, id: string) {
  const d = await getSellerReturn(db, s.ctx, id);
  if (!d?.refundPreview || d.queueVersion === null || !d.fault) throw new Error("no preview");
  return { amount: d.refundPreview.byFault[d.fault].refundAmount, queueVersion: d.queueVersion };
}

describe("반품 환불 연결", () => {
  it("판매자 사정: 상품 + 처음 배송비를 돌려주고 신청은 완료로 닫히며 주문은 환불 상태가 된다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const req = await s.ret(id);
    await proceedToReceived(s, req.id);
    const p = await shopPreview(s, req.id);
    expect(p.amount).toBe(16000);
    const r = await refundReturn(db, s.ctx, req.id, { expectedVersion: p.queueVersion, expectedRefundAmount: p.amount });
    expect(r).toMatchObject({ ok: true, request: { status: "COMPLETED", refundAmount: 16000 }, refund: { refundAmount: 16000, refundFault: "SELLER" } });
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "REFUNDED", refundAmount: 16000, refundFault: "SELLER" });
    expect((await db.auditLog.findMany({ where: { targetId: req.id }, orderBy: { createdAt: "asc" } })).map((a) => a.action)).toEqual(["buyer_return.create", "return.accept", "return.receive", "return.inspect", "return.refund"]);
    expect(await refundReturn(db, s.ctx, req.id, { expectedVersion: await lv(s.seller.id), expectedRefundAmount: 16000 })).toEqual({ ok: false, reason: "invalid_transition" });
  });

  it("구매자 사정: 반품 배송비를 뺀 금액이고, 확인한 금액이 다르면 아무것도 바꾸지 않는다", async () => {
    const s = await shop();
    await db.sellerShippingPolicy.upsert({ where: { sellerId: s.seller.id }, create: { sellerId: s.seller.id, returnFee: 2500 }, update: { returnFee: 2500 } }).catch(() => undefined);
    const id = await s.delivered();
    const req = await s.ret(id, { reason: "CHANGE_OF_MIND" });
    await proceedToReceived(s, req.id);
    const p = await shopPreview(s, req.id);
    const wrong = await refundReturn(db, s.ctx, req.id, { expectedVersion: p.queueVersion, expectedRefundAmount: p.amount + 1 });
    expect(wrong).toEqual({ ok: false, reason: "refund_amount_changed", refund: true });
    expect(await status(req.id)).toBe("RECEIVED");
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PAID", refundAmount: null });
    const ok = await refundReturn(db, s.ctx, req.id, { expectedVersion: await lv(s.seller.id), expectedRefundAmount: p.amount });
    expect(ok).toMatchObject({ ok: true, request: { status: "COMPLETED", refundAmount: p.amount }, refund: { refundFault: "BUYER" } });
    expect(p.amount).toBeLessThan(13000);
  });

  it("직접 환불하면 진행 중인 신청을 닫는다(반품 회수 완료는 완료, 그 밖은 철회)", async () => {
    const s = await shop();
    const a = await s.delivered();
    const ra = await s.ret(a);
    await acceptReturn(db, s.ctx, ra.id, {});
    const b = await s.delivered();
    const rb = await s.ret(b);
    await proceedToReceived(s, rb.id);
    const c = await s.delivered();
    const rc = await s.exch(c, [(await s.items(c))[0].id]);
    await proceedToReceived(s, rc.id);
    for (const id of [a, b, c]) expect(await refundOrder(db, s.ctx, id, { reason: "직접 환불", expectedLiveVersion: await lv(s.seller.id), fault: "SELLER" })).toMatchObject({ ok: true });
    expect(await status(ra.id)).toBe("CANCELLED");
    expect(await db.returnRequest.findUniqueOrThrow({ where: { id: rb.id } })).toMatchObject({ status: "COMPLETED", refundAmount: 16000 });
    expect(await status(rc.id)).toBe("CANCELLED");
  });
});

describe("자동 구매 확정", () => {
  it("진행 중인 신청이 있는 주문은 확정하지 않고, 신청이 닫히면 확정한다", async () => {
    const s = await shop();
    const id = await s.delivered();
    await db.shipment.update({ where: { orderId: id }, data: { deliveredAt: new Date(Date.now() - 10 * DAY) } });
    const req = await s.ret(id);
    expect(await autoConfirmPurchases(db, {})).toMatchObject({ done: [] });
    expect((await db.order.findUniqueOrThrow({ where: { id } })).purchaseConfirmedAt).toBeNull();
    await buyerCancelReturn(db, s.scope, req.id);
    expect((await autoConfirmPurchases(db, {})).done).toContain(id);
    expect((await db.order.findUniqueOrThrow({ where: { id } })).purchaseConfirmedAt).not.toBeNull();
  });
});

describe("권한·판매자 격리", () => {
  it("주문·배송 권한 없는 직원은 보지도 처리하지도 못하고, 다른 쇼핑몰은 신청을 볼 수 없다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const req = await s.ret(id);
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    const sctx: TenantContext = { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] };
    await expect(listSellerReturns(db, sctx)).rejects.toThrow();
    await expect(acceptReturn(db, sctx, req.id, {})).rejects.toThrow();
    await expect(getSellerReturn(db, sctx, req.id)).rejects.toThrow();
    const ro: TenantContext = { ...s.ctx, readOnly: true };
    await expect(acceptReturn(db, ro, req.id, {})).rejects.toThrow();
    const other = await shop();
    expect(await acceptReturn(db, other.ctx, req.id, {})).toEqual({ ok: false, reason: "not_found" });
    expect(await getSellerReturn(db, other.ctx, req.id)).toBeNull();
    expect((await listSellerReturns(db, other.ctx)).returns).toEqual([]);
    expect((await listSellerReturns(db, s.ctx)).returns).toHaveLength(1);
    expect(await status(req.id)).toBe("REQUESTED");
  });

  it("라우트: 로그인한 대표자는 목록을 보고, 로그인하지 않으면 401", async () => {
    const s = await shop();
    const id = await s.delivered();
    await s.ret(id);
    const login = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const ok = await sellerListGet(new Request("http://localhost:3000/api/seller/returns?status=REQUESTED", { headers: { ...H, cookie: `lo_seller=${login.token}` } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ returns: [{ status: "REQUESTED" }], counts: { REQUESTED: 1 } });
    expect((await sellerListGet(new Request("http://localhost:3000/api/seller/returns", { headers: H }))).status).toBe(401);
  });

  it("라우트: 구매자가 사진을 올리고 신청하며, 로그인하지 않으면 401", async () => {
    const s = await shop();
    const id = await s.delivered();
    const login = await loginBuyer(db, { sellerId: s.seller.id, loginId: s.buyer.loginId, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const cookie = `lo_buyer=${login.token}`;
    const p = { params: Promise.resolve({ slug: s.seller.slug }) };
    const img = await buyerImagePost(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie }, body: new Uint8Array(jpeg(400, 300)) }), p);
    expect(img.status).toBe(201);
    const { image } = (await img.json()) as { image: { id: string } };
    const res = await buyerCreatePost(
      new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie, "content-type": "application/json" }, body: JSON.stringify({ orderId: id, kind: "RETURN", reason: "DEFECTIVE", imageIds: [image.id] }) }),
      p,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ request: { status: "REQUESTED", images: [{ id: image.id }] } });
    const again = await buyerCreatePost(
      new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie, "content-type": "application/json" }, body: JSON.stringify({ orderId: id, kind: "RETURN", reason: "DEFECTIVE" }) }),
      p,
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "active_exists", message: expect.stringContaining("이미 진행 중인 신청") });
    const anon = await buyerCreatePost(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, "content-type": "application/json" }, body: "{}" }), p);
    expect(anon.status).toBe(401);
  });
});

describe("사진", () => {
  it("위치 정보를 지우고 저장하며, 본인만 신청 전 사진을 보고, 파트너스는 신청에 붙은 사진만 본다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const up = await uploadReturnImage(db, s.scope, jpeg(400, 300, { exif: true }));
    if (!up.ok) throw new Error(up.reason);
    const stored = await db.returnRequestImage.findUniqueOrThrow({ where: { id: up.image.id } });
    expect(hasImageMetadata(Buffer.from(stored.data))).toBe(false);
    expect(Buffer.from(stored.data).includes(GPS_EXIF)).toBe(false);
    expect(await buyerReturnImage(db, s.scope, up.image.id)).not.toBeNull();
    expect(await buyerReturnImage(db, { sellerId: s.seller.id, buyerMemberId: s.other.id }, up.image.id)).toBeNull();
    expect(await sellerReturnImage(db, s.ctx, up.image.id)).toBeNull();
    const req = await s.ret(id, { imageIds: [up.image.id] });
    expect(req.images).toHaveLength(1);
    expect(await sellerReturnImage(db, s.ctx, up.image.id)).not.toBeNull();
    const other = await shop();
    expect(await sellerReturnImage(db, other.ctx, up.image.id)).toBeNull();
    // 이미 붙은 사진은 다른 신청에 다시 붙일 수 없다
    await buyerCancelReturn(db, s.scope, req.id);
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", imageIds: [up.image.id] })).toEqual({ ok: false, reason: "invalid_images" });
    expect(await uploadReturnImage(db, s.scope, Buffer.from("not an image"))).toMatchObject({ ok: false });
  });
});

describe("탈퇴", () => {
  it("신청 전 사진은 지우고 신청과 붙은 사진은 법정 보관으로 남는다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const a = await uploadReturnImage(db, s.scope, jpeg(300, 300));
    const b = await uploadReturnImage(db, s.scope, jpeg(300, 300));
    if (!a.ok || !b.ok) throw new Error("upload");
    const req = await s.ret(id, { imageIds: [a.image.id] });
    await acceptReturn(db, s.ctx, req.id, {});
    await buyerCancelReturn(db, s.scope, req.id);
    // 환불 전에 탈퇴해 계좌가 남은 경우도 탈퇴 때 비운다
    await db.returnRequest.update({ where: { id: req.id }, data: { refundBankName: "국민", refundAccountHolder: "김구매", refundAccountNumber: "123-456-789012" } });
    expect(await withdrawBuyer(db, s.scope, { password: PASSWORD })).toEqual({ ok: true });
    expect(await db.returnRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ refundBankName: null, refundAccountHolder: null, refundAccountNumber: null });
    expect(await db.returnRequestImage.findUnique({ where: { id: b.image.id } })).toBeNull();
    expect(await db.returnRequestImage.findUnique({ where: { id: a.image.id } })).not.toBeNull();
    expect(await db.returnRequest.count({ where: { id: req.id } })).toBe(1);
  });
});

beforeEach(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
});

describe("교환·반품 v2: 기한·개봉·수거·검수·교환 재고 없음·무통장 환불 계좌", () => {
  it("배송 완료 7일이 지나면 단순 변심·기타는 막고, 판매자 사정 사유는 받는다(기한 표시 포함)", async () => {
    const s = await shop();
    const id = await s.delivered();
    expect(await buyerReturnContext(db, s.scope, id)).toMatchObject({ windowOpen: true });
    await db.shipment.update({ where: { orderId: id }, data: { deliveredAt: new Date(Date.now() - 8 * DAY) } });
    expect(await buyerReturnContext(db, s.scope, id)).toMatchObject({ windowOpen: false });
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "CHANGE_OF_MIND" })).toEqual({ ok: false, reason: "period_expired" });
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "OTHER", reasonText: "그냥" })).toEqual({ ok: false, reason: "period_expired" });
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE" })).toMatchObject({ ok: true });
    const id2 = await s.delivered();
    await db.shipment.update({ where: { orderId: id2 }, data: { deliveredAt: new Date(Date.now() - 6 * DAY) } });
    expect(await createReturn(db, s.scope, id2, { orderId: id2, kind: "RETURN", reason: "CHANGE_OF_MIND" })).toMatchObject({ ok: true });
  });

  it("개봉한 상품은 단순 변심으로 신청할 수 없고(교환은 하나라도, 반품은 전부 개봉일 때), 불량 사유는 받는다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const its = await s.items(id);
    const q = await db.queueItem.findMany({ where: { orderId: id } });
    expect(q.length).toBeGreaterThan(0);
    await db.queueItem.updateMany({ where: { orderItemId: its[0].id }, data: { openingStartedAt: new Date() } });
    expect((await buyerReturnContext(db, s.scope, id))?.items.map((i) => i.opened).sort()).toEqual([false, true]);
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "EXCHANGE", reason: "CHANGE_OF_MIND", orderItemIds: [its[0].id] })).toEqual({ ok: false, reason: "opened_blocked" });
    // 일부만 개봉한 반품은 신청되고(환불은 개봉분을 뺀다), 불량 교환은 개봉해도 받는다
    const cancel = await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "CHANGE_OF_MIND" });
    expect(cancel).toMatchObject({ ok: true });
    if (cancel.ok) await buyerCancelReturn(db, s.scope, cancel.request.id);
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "EXCHANGE", reason: "DEFECTIVE", orderItemIds: [its[0].id] })).toMatchObject({ ok: true });
    const id2 = await s.delivered();
    await db.queueItem.updateMany({ where: { orderId: id2 }, data: { openingStartedAt: new Date() } });
    expect(await createReturn(db, s.scope, id2, { orderId: id2, kind: "RETURN", reason: "CHANGE_OF_MIND" })).toEqual({ ok: false, reason: "opened_blocked" });
  });

  it("수거 방법: 구매자 희망을 저장하고 접수할 때 판매자가 바꾼다(잘못된 값은 거절)", async () => {
    const s = await shop();
    const id = await s.delivered();
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", pickup: "NONE" })).toEqual({ ok: false, reason: "invalid_pickup" });
    const r = await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", pickup: "COURIER" });
    if (!r.ok) throw new Error(r.reason);
    expect(r.request.pickupMethod).toBe("COURIER");
    expect(await acceptReturn(db, s.ctx, r.request.id, { pickup: "SPACESHIP" })).toEqual({ ok: false, reason: "invalid_pickup" });
    expect(await acceptReturn(db, s.ctx, r.request.id, { pickup: "NONE" })).toMatchObject({ ok: true, request: { pickupMethod: "NONE", status: "ACCEPTED" } });
  });

  it("검수 전에는 환불·교환 발송을 못 하고, 문제가 있으면 반송·거절만 된다(이상 없음이면 거절 불가)", async () => {
    const s = await shop();
    const id = await s.delivered();
    const req = await s.ret(id);
    expect(await inspectReturn(db, s.ctx, req.id, { result: "OK" })).toEqual({ ok: false, reason: "invalid_transition" });
    await acceptReturn(db, s.ctx, req.id, {});
    await receiveReturn(db, s.ctx, req.id, {});
    const v = await lv(s.seller.id);
    expect(await refundReturn(db, s.ctx, req.id, { expectedVersion: v, expectedRefundAmount: 16000 })).toEqual({ ok: false, reason: "inspection_required" });
    expect(await rejectInspectedReturn(db, s.ctx, req.id, { reason: "봉인 훼손" })).toEqual({ ok: false, reason: "inspection_required" });
    expect(await inspectReturn(db, s.ctx, req.id, { result: "BROKEN" })).toEqual({ ok: false, reason: "invalid_inspection" });
    expect(await inspectReturn(db, s.ctx, req.id, { result: "USED_DAMAGED", note: "봉인 훼손" })).toMatchObject({ ok: true, request: { inspectionResult: "USED_DAMAGED", inspectionNote: "봉인 훼손" } });
    expect(await refundReturn(db, s.ctx, req.id, { expectedVersion: v, expectedRefundAmount: 16000 })).toEqual({ ok: false, reason: "inspection_not_ok" });
    expect(await rejectInspectedReturn(db, s.ctx, req.id, { reason: "" })).toEqual({ ok: false, reason: "invalid_reject_reason" });
    expect(await rejectInspectedReturn(db, s.ctx, req.id, { reason: "봉인 훼손 확인으로 반송합니다" })).toMatchObject({ ok: true, request: { status: "REJECTED", rejectReason: "봉인 훼손 확인으로 반송합니다" } });
    // 이상 없음은 거절할 수 없다
    const id2 = await s.delivered();
    const r2 = await s.ret(id2);
    await proceedToReceived(s, r2.id);
    expect(await rejectInspectedReturn(db, s.ctx, r2.id, { reason: "그냥" })).toEqual({ ok: false, reason: "wrong_kind" });
    // 직원 권한 없는 사용자는 검수도 못 한다
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    const sctx: TenantContext = { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] };
    await expect(inspectReturn(db, sctx, r2.id, { result: "OK" })).rejects.toThrow();
    await expect(holdExchange(db, sctx, r2.id)).rejects.toThrow();
    await expect(convertExchangeToRefund(db, sctx, r2.id)).rejects.toThrow();
  });

  it("교환 재고 없음: 검수 전엔 처리 못 하고, 재입고 뒤 발송으로 보류했다가 보내면 보류가 풀린다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const its = await s.items(id);
    const req = await s.exch(id, [its[0].id]);
    await acceptReturn(db, s.ctx, req.id, {});
    await receiveReturn(db, s.ctx, req.id, {});
    expect(await holdExchange(db, s.ctx, req.id)).toEqual({ ok: false, reason: "inspection_required" });
    expect(await shipExchange(db, s.ctx, req.id, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "inspection_required" });
    await inspectReturn(db, s.ctx, req.id, { result: "OK" });
    await db.productOption.update({ where: { id: its[0].optionId }, data: { stock: 0 } });
    expect(await shipExchange(db, s.ctx, req.id, { courier: "CJ", trackingNumber: "123456789012" })).toEqual({ ok: false, reason: "insufficient_stock" });
    expect(await holdExchange(db, s.ctx, req.id)).toMatchObject({ ok: true, request: { status: "RECEIVED" } });
    expect((await db.returnRequest.findUniqueOrThrow({ where: { id: req.id } })).exchangeHeldAt).not.toBeNull();
    await db.productOption.update({ where: { id: its[0].optionId }, data: { stock: 10 } });
    expect(await shipExchange(db, s.ctx, req.id, { courier: "CJ", trackingNumber: "123456789012" })).toMatchObject({ ok: true, request: { status: "COMPLETED", exchangeHeldAt: null } });
  });

  it("교환 재고 없음: 환불로 전환하면 신청한 품목만 환불하고 신청이 완료로 닫힌다(반품은 전환 불가)", async () => {
    const s = await shop();
    const id = await s.delivered();
    const its = await s.items(id); // 부스터 팩(5,000×2), 슬리브(3,000×1)
    const pack = its.find((i) => i.productNameSnapshot === "부스터 팩")!;
    const req = await s.exch(id, [pack.id]);
    await proceedToReceived(s, req.id);
    expect(await convertExchangeToRefund(db, s.ctx, req.id)).toMatchObject({ ok: true, request: { kind: "RETURN", convertedFromExchange: true } });
    const ret = await s.ret(await s.delivered());
    await proceedToReceived(s, ret.id);
    expect(await convertExchangeToRefund(db, s.ctx, ret.id)).toEqual({ ok: false, reason: "wrong_kind" });
    const p = await getSellerReturn(db, s.ctx, req.id);
    // 부스터 팩 10,000원만(판매자 사정: 상품만, 배송비는 전체 환불이 아니라 돌려주지 않음)
    expect(p?.refundPreview?.byFault.SELLER.itemsAmount).toBe(10000);
    const r = await refundReturn(db, s.ctx, req.id, { expectedVersion: p!.queueVersion!, expectedRefundAmount: p!.refundPreview!.byFault.SELLER.refundAmount });
    expect(r).toMatchObject({ ok: true, request: { status: "COMPLETED", convertedFromExchange: true } });
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PAID" });
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: pack.id } })).refundedQuantity).toBe(2);
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: its.find((i) => i.id !== pack.id)!.id } })).refundedQuantity).toBe(0);
  });

  it("무통장 입금 주문은 환불 계좌 없이 신청할 수 없고, 계좌는 파트너스만 보며 환불·종료 뒤 비워진다", async () => {
    const s = await shop();
    const mk = async () => {
      const r = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: s.oa.id, quantity: 1 }], consent, shippingAddress: addr });
      if (!r.ok) throw new Error(r.reason);
      await markOrderPaid(db, { sellerId: s.seller.id, orderId: r.orderId, paymentMethod: "BANK_TRANSFER" });
      expect((await shipOrder(db, s.ctx, r.orderId, { courier: "CJ", trackingNumber: "123456789012" })).ok).toBe(true);
      await completeDelivery(db, s.ctx, r.orderId);
      return r.orderId;
    };
    const id = await mk();
    expect(await buyerReturnContext(db, s.scope, id)).toMatchObject({ needsRefundAccount: true });
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE" })).toEqual({ ok: false, reason: "refund_account_required" });
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", refundAccount: { bankName: "국민", accountHolder: "김구매", accountNumber: "12" } })).toEqual({ ok: false, reason: "invalid_refund_account" });
    const acct = { bankName: "국민", accountHolder: "김구매", accountNumber: "123-456-789012" };
    const r = await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", refundAccount: acct });
    if (!r.ok) throw new Error(r.reason);
    // 구매자 응답에는 계좌가 없고 보유 여부만, 파트너스 상세에는 있다
    expect(JSON.stringify(r.request)).not.toContain("123-456-789012");
    // DB에는 원문이 아니라 봉인된 값(v1.…)이 저장되고, 파트너스 상세에서만 풀려 보인다
    const raw = await db.returnRequest.findUniqueOrThrow({ where: { id: r.request.id } });
    expect(raw.refundAccountNumber).toMatch(/^v1\./);
    expect(raw.refundAccountNumber).not.toContain("789012");
    expect(r.request.hasRefundAccount).toBe(true);
    expect(await getSellerReturn(db, s.ctx, r.request.id)).toMatchObject({ refundAccount: acct, paymentMethod: "BANK_TRANSFER" });
    await proceedToReceived(s, r.request.id);
    const p = await getSellerReturn(db, s.ctx, r.request.id);
    expect(await refundReturn(db, s.ctx, r.request.id, { expectedVersion: p!.queueVersion!, expectedRefundAmount: p!.refundPreview!.byFault.SELLER.refundAmount })).toMatchObject({ ok: true, request: { status: "COMPLETED", hasRefundAccount: false } });
    expect(await getSellerReturn(db, s.ctx, r.request.id)).toMatchObject({ refundAccount: null });
    // 카드 주문은 계좌를 받지 않는다(보내도 저장하지 않는다)
    const card = await s.delivered();
    const cr = await createReturn(db, s.scope, card, { orderId: card, kind: "RETURN", reason: "DEFECTIVE", refundAccount: acct });
    expect(cr).toMatchObject({ ok: true, request: { hasRefundAccount: false } });
    // 철회하면 계좌를 비운다
    const id3 = await mk();
    const r3 = await createReturn(db, s.scope, id3, { orderId: id3, kind: "RETURN", reason: "DEFECTIVE", refundAccount: acct });
    if (!r3.ok) throw new Error(r3.reason);
    expect(await buyerCancelReturn(db, s.scope, r3.request.id)).toMatchObject({ ok: true, request: { hasRefundAccount: false } });
  });

  it("요약 카드: 접수 대기·수거 검수 중·이번 달 완료·30일 반품률", async () => {
    const s = await shop();
    const a = await s.delivered();
    const b = await s.delivered();
    await s.delivered();
    const ra = await s.ret(a);
    const rb = await s.ret(b);
    await acceptReturn(db, s.ctx, rb.id, {});
    let sum = (await listSellerReturns(db, s.ctx)).summary;
    expect(sum).toMatchObject({ requested: 1, inProgress: 1, doneReturn: 0, doneExchange: 0, returnRate30: 66.7 });
    await receiveReturn(db, s.ctx, rb.id, {});
    await inspectReturn(db, s.ctx, rb.id, { result: "OK" });
    const p = await getSellerReturn(db, s.ctx, rb.id);
    await refundReturn(db, s.ctx, rb.id, { expectedVersion: p!.queueVersion!, expectedRefundAmount: p!.refundPreview!.byFault.SELLER.refundAmount });
    sum = (await listSellerReturns(db, s.ctx)).summary;
    expect(sum).toMatchObject({ requested: 1, inProgress: 0, doneReturn: 1 });
    expect(ra.id).toBeTruthy();
  });
});

describe("부분 반품·환불 내역", () => {
  it("품목·수량을 골라 반품 신청하고(남은 수량 안에서만), 환불은 신청 품목만 하며 주문은 결제 완료로 남는다", async () => {
    const s = await shop();
    const id = await s.delivered();
    // 대기 중인 주문대기가 있으면 일부 수량 환불이 막힌다(queued_item_partial). 주문대기 없는 주문으로 만든다.
    await db.queueItem.deleteMany({ where: { orderId: id } });
    const its = await s.items(id);
    const pack = its.find((i) => i.productNameSnapshot === "부스터 팩")!; // 5,000 × 2
    const bad = async (items: unknown) => ((await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", items })) as { reason?: string }).reason;
    expect(await bad([])).toBe("invalid_items");
    expect(await bad([{ orderItemId: pack.id, quantity: 3 }])).toBe("invalid_items");
    expect(await bad([{ orderItemId: pack.id, quantity: 0 }])).toBe("invalid_items");
    expect(await bad([{ orderItemId: pack.id, quantity: 1 }, { orderItemId: pack.id, quantity: 1 }])).toBe("invalid_items");
    expect(await bad([{ orderItemId: "00000000-0000-4000-8000-000000000000", quantity: 1 }])).toBe("invalid_items");
    expect(await db.returnRequest.count()).toBe(0);
    const r = await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", items: [{ orderItemId: pack.id, quantity: 1 }] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.request.items).toMatchObject([{ orderItemId: pack.id, quantity: 1, orderQuantity: 2 }]);
    await proceedToReceived(s, r.request.id);
    const p = await getSellerReturn(db, s.ctx, r.request.id);
    expect(p?.partialQuantity).toBe(true);
    expect(p?.refundPreview?.byFault.SELLER).toMatchObject({ itemsAmount: 5000 });
    const done = await refundReturn(db, s.ctx, r.request.id, { expectedVersion: p!.queueVersion!, expectedRefundAmount: p!.refundPreview!.byFault.SELLER.refundAmount });
    expect(done).toMatchObject({ ok: true, request: { status: "COMPLETED", refundAmount: p!.refundPreview!.byFault.SELLER.refundAmount } });
    expect(await db.order.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "PAID" });
    expect((await db.orderItem.findUniqueOrThrow({ where: { id: pack.id } })).refundedQuantity).toBe(1);
    // 환불 내역: 파트너스 상세와 구매자 화면 모두 한 건, 품목·수량이 보인다
    const after = await getSellerReturn(db, s.ctx, r.request.id);
    expect(after?.refunds).toMatchObject([{ seq: 1, isFinal: false, items: [{ quantity: 1, productName: "부스터 팩" }] }]);
    const ctx = await buyerReturnContext(db, s.scope, id);
    expect(ctx?.refunds).toMatchObject([{ seq: 1, items: [{ quantity: 1, productName: "부스터 팩" }] }]);
    expect(JSON.stringify(ctx?.refunds)).not.toContain("actorId");
    // 닫혔으니 남은 수량(팩 1 + 슬리브 1)으로 다시 신청할 수 있고, 남은 수량을 넘으면 거절
    expect(ctx).toMatchObject({ canRequest: true });
    expect(ctx?.items.map((i) => i.quantity).sort()).toEqual([1, 1]);
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", items: [{ orderItemId: pack.id, quantity: 2 }] })).toEqual({ ok: false, reason: "invalid_items" });
    expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE" })).toMatchObject({ ok: true });
  });

  it("일부 수량만 반품한 품목은 검수 재고 되돌리기를 하지 않고, 전체 수량 품목만 되돌린다", async () => {
    const s = await shop();
    const id = await s.delivered();
    const its = await s.items(id);
    const pack = its.find((i) => i.productNameSnapshot === "부스터 팩")!;
    const sleeve = its.find((i) => i.productNameSnapshot === "슬리브")!;
    const at = [await stock(s.oa.id), await stock(s.ob.id)];
    const r = await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", items: [{ orderItemId: pack.id, quantity: 1 }, { orderItemId: sleeve.id, quantity: 1 }] });
    if (!r.ok) throw new Error(r.reason);
    await acceptReturn(db, s.ctx, r.request.id, {});
    await receiveReturn(db, s.ctx, r.request.id, {});
    expect(await inspectReturn(db, s.ctx, r.request.id, { result: "OK", restock: true })).toMatchObject({ ok: true, request: { restocked: true } });
    // 슬리브(전체 수량 1)만 되돌아가고 팩(2개 중 1개)은 그대로
    expect([await stock(s.oa.id), await stock(s.ob.id)]).toEqual([at[0], at[1] + 1]);
  });
});

describe("환불 계좌번호 봉인", () => {
  const acct = { bankName: "국민", accountHolder: "김구매", accountNumber: "123-456-789012" };
  const bankOrder = async (s: Awaited<ReturnType<typeof shop>>) => {
    const r = await createOrder(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id, items: [{ optionId: s.oa.id, quantity: 1 }], consent, shippingAddress: addr });
    if (!r.ok) throw new Error(r.reason);
    await markOrderPaid(db, { sellerId: s.seller.id, orderId: r.orderId, paymentMethod: "BANK_TRANSFER" });
    expect((await shipOrder(db, s.ctx, r.orderId, { courier: "CJ", trackingNumber: "123456789012" })).ok).toBe(true);
    await completeDelivery(db, s.ctx, r.orderId);
    return r.orderId;
  };

  it("비밀키가 없으면 신청을 받지 않고 원문을 저장하지 않는다", async () => {
    const s = await shop();
    const id = await bankOrder(s);
    const saved = process.env.BILLING_KEY_SECRET;
    delete process.env.BILLING_KEY_SECRET;
    try {
      expect(await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", refundAccount: acct })).toEqual({ ok: false, reason: "refund_account_unavailable" });
    } finally {
      process.env.BILLING_KEY_SECRET = saved;
    }
    expect(await db.returnRequest.count()).toBe(0);
  });

  it("다른 쇼핑몰 행으로 옮기면 풀리지 않고, 봉인 전 원문 값은 그대로 보이며, 로그 추적에는 번호가 없다", async () => {
    const s = await shop();
    const id = await bankOrder(s);
    const r = await createReturn(db, s.scope, id, { orderId: id, kind: "RETURN", reason: "DEFECTIVE", refundAccount: acct });
    if (!r.ok) throw new Error(r.reason);
    expect(await getSellerReturn(db, s.ctx, r.request.id)).toMatchObject({ refundAccount: { accountNumber: "123-456-789012" } });
    expect(JSON.stringify(await db.auditLog.findMany({ where: { targetId: r.request.id } }))).not.toMatch(/789012|v1\./);
    // 봉인 전(#455 직후) 원문으로 저장된 값은 그대로 보인다
    await db.returnRequest.update({ where: { id: r.request.id }, data: { refundAccountNumber: "111-222-333444" } });
    expect(await getSellerReturn(db, s.ctx, r.request.id)).toMatchObject({ refundAccount: { accountNumber: "111-222-333444" } });
    // 다른 쇼핑몰 id로 봉인된 값을 옮겨 붙이면 풀리지 않는다(null)
    const other = await shop();
    const sealed = (await import("../../lib/server/billing/secret")).sealBillingKey("999-888-777666", other.seller.id);
    await db.returnRequest.update({ where: { id: r.request.id }, data: { refundAccountNumber: sealed } });
    expect(await getSellerReturn(db, s.ctx, r.request.id)).toMatchObject({ refundAccount: { accountNumber: null } });
  });
});
