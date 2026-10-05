import { cleanText } from "../text/clean";
import { Prisma, type ActorType, type PrismaClient, type RefundFault, type ReturnKind, type ReturnReason, type ReturnStatus } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { assertBillingSecret, openBillingKey, sealBillingKey } from "../billing/secret";
import { shopOpen } from "../buyers/signup";
import { checkReviewImage, type ReviewImageRejection } from "../product-reviews/image";
import { getRefundVersion } from "../queue/read";
import { previewRefundSelection, refundOrder, type RefundSelection } from "../queue/service";
import { restoreOrderStock } from "../products/stock";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { ACTIVE_STATUSES, CLEAR_ACCOUNT, courierName, DEFAULT_FAULT, INSPECTION_NOTE_MAX, isUuid, parseFault, parseInspection, parseNewReturn, parsePickup, parseRejectReason, parseTracking, returnDeadline, TRANSITIONS, withinReturnWindow, type ReturnRejection } from "./rules";
import { returnImageStore } from "./store";
import { orderNoLabel } from "../orders/orderNoLabel";

// 교환·반품(SA-029 파트너스 · SH-022-R 구매자, 2026-10-04 대표님 지시).
// - 구매자: 배송 완료 뒤 구매 확정 전인 결제 완료 주문에 신청한다. 반품은 주문 전체, 교환은 품목 단위(품목의 수량 전체). 주문당 진행 중인 신청은 1건(DB 부분 유니크 인덱스).
//   진행 중인 신청이 있으면 자동 구매 확정이 그 주문을 확정하지 않는다(orders/delivery.ts).
// - 파트너스(ORDER_SHIPPING): 접수(사유 주체 정함) → 회수 완료(재고 되돌리기 선택) → 반품은 환불 연결, 교환은 교환 발송(교환 상품 재고를 뺌). 신청 단계에서는 거절할 수 있다.
// - 환불은 기존 환불(queue/service.ts refundOrder)을 호출만 한다. 실제 PG 취소는 결제 연결이 맡는다. 환불이 같은 트랜잭션에서 신청을 완료로 닫는다(closeReturnsOnRefund).
//   파트너스가 주문 화면에서 직접 환불해도 진행 중인 신청은 같은 방식으로 닫힌다(반품 회수 완료분은 완료, 그 밖은 철회).
// - 잠금 순서(모든 쓰기 경로): 주문 행(FOR UPDATE) → 회원 행(FOR SHARE) → 신청 행(FOR UPDATE) → 옵션 재고. 환불은 주문 행을 먼저 잡고 같은 순서로 신청을 닫는다.
// - 모든 변경은 로그 추적(AuditLog)에 남는다.

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };
export type BuyerScope = { sellerId: string; buyerMemberId: string };
const UNATTACHED_KEEP = 10;
const PAGE = 30;
const isUniqueViolation = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

export type ReturnFailure =
  | ReturnRejection
  | "shop_unavailable"
  | "not_found"
  | "not_returnable"
  | "active_exists"
  | "invalid_transition"
  | "fault_required"
  | "insufficient_stock"
  | "wrong_kind"
  | "period_expired"
  | "opened_blocked"
  | "refund_account_required"
  | "refund_account_unavailable"
  | "inspection_required"
  | "inspection_not_ok"
  | "inspection_locked";

// 구매자 화면 안내(해요체) / 파트너스 화면 안내(합니다체)
export const BUYER_RETURN_MESSAGES: Record<string, string> = {
  shop_unavailable: "지금은 신청할 수 없어요",
  not_found: "신청을 찾을 수 없어요",
  not_returnable: "지금은 교환·반품을 신청할 수 없는 주문이에요",
  active_exists: "이미 진행 중인 신청이 있어요",
  invalid_transition: "이미 처리된 신청이에요. 화면을 새로 고쳐 주세요",
  invalid_kind: "교환 또는 반품을 골라 주세요",
  invalid_reason: "사유를 골라 주세요",
  invalid_reason_text: "자세한 사유를 입력해 주세요 (500자 이내)",
  invalid_items: "신청할 상품을 골라 주세요",
  invalid_images: "사진을 확인해 주세요 (5장까지)",
  invalid_courier: "택배사를 골라 주세요",
  invalid_tracking: "송장 번호를 확인해 주세요",
  invalid_pickup: "수거 방법을 확인해 주세요",
  invalid_refund_account: "환불 계좌(은행·예금주·계좌번호)를 확인해 주세요",
  refund_account_required: "환불받을 계좌를 입력해 주세요",
  refund_account_unavailable: "지금은 계좌 정보를 안전하게 저장할 수 없어요. 잠시 뒤 다시 해 주세요",
  period_expired: "배송 완료 뒤 7일이 지나 신청할 수 없어요. 불량·오배송은 판매자에게 문의해 주세요",
  opened_blocked: "개봉한 상품은 단순 변심으로 교환·반품할 수 없어요. 불량·오배송은 판매자에게 문의해 주세요",
  empty_file: "사진을 확인해 주세요",
  file_too_large: "사진은 5MB 이하로 올려 주세요",
  unsupported_image: "JPG, PNG, WEBP 사진만 올릴 수 있어요",
  wrong_image_size: "사진 가로·세로가 맞지 않아요. 가로·세로 100~4,000px 사진으로 올려 주세요",
  png_16bit: "사진을 다른 형식으로 올려 주세요",
  png_too_large: "사진 크기가 너무 커요",
};
export const SELLER_RETURN_MESSAGES: Record<string, string> = {
  not_found: "신청을 찾을 수 없습니다",
  invalid_transition: "이미 처리된 신청입니다. 화면을 새로 고쳐 주십시오",
  not_returnable: "교환·반품을 처리할 수 없는 주문입니다",
  fault_required: "사유 주체(구매자 사정·판매자 사정)를 골라 주십시오",
  invalid_fault: "사유 주체를 골라 주십시오",
  invalid_reject_reason: "거절 사유를 입력해 주십시오 (200자 이내)",
  invalid_courier: "택배사를 골라 주십시오",
  invalid_tracking: "송장 번호를 확인해 주십시오",
  insufficient_stock: "교환 상품의 재고가 부족합니다",
  wrong_kind: "이 신청에서는 할 수 없는 처리입니다",
  invalid_pickup: "수거 방법을 골라 주십시오",
  invalid_inspection: "검수 결과를 골라 주십시오",
  inspection_required: "검수 결과를 먼저 입력해 주십시오",
  inspection_not_ok: "검수에서 문제가 확인된 건은 반송·거절로 처리해 주십시오",
  inspection_locked: "재고를 이미 되돌려 검수 결과를 바꿀 수 없습니다",
};

async function clockNow(db: Db): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT date_trunc('milliseconds', clock_timestamp()) AS now`;
  return rows[0].now;
}

async function lockOrder(tx: Tx, sellerId: string, orderId: string) {
  const [o] = await tx.$queryRaw<{ status: string; buyerMemberId: string; purchaseConfirmedAt: Date | null; legalHoldAt: Date | null }[]>`
    SELECT "status"::text AS "status", "buyerMemberId", "purchaseConfirmedAt", "legalHoldAt" FROM "Order"
    WHERE "id" = ${orderId}::uuid AND "sellerId" = ${sellerId}::uuid FOR UPDATE`;
  return o ?? null;
}

async function lockRequest(tx: Tx, sellerId: string, id: string) {
  const [r] = await tx.$queryRaw<{ id: string; orderId: string; kind: ReturnKind; status: ReturnStatus; reason: ReturnReason; fault: RefundFault | null; buyerMemberId: string }[]>`
    SELECT "id", "orderId", "kind"::text AS "kind", "status"::text AS "status", "reason"::text AS "reason", "fault"::text AS "fault", "buyerMemberId" FROM "ReturnRequest"
    WHERE "id" = ${id}::uuid AND "sellerId" = ${sellerId}::uuid FOR UPDATE`;
  return r as (typeof r & { kind: ReturnKind; status: ReturnStatus; reason: ReturnReason; fault: RefundFault | null }) | undefined;
}

// 개봉을 시작했거나 마친 주문 품목(주문대기가 개봉 중·완료). 환불 계산(queue/service.ts isOpened)과 같은 기준이다.
async function openedOrderItemIds(db: Db, sellerId: string, orderId: string): Promise<Set<string>> {
  const q = await db.queueItem.findMany({ where: { sellerId, orderId }, select: { orderItemId: true, openingStartedAt: true, status: true } });
  return new Set(q.filter((x) => x.openingStartedAt !== null || x.status === "OPENING" || x.status === "DONE").flatMap((x) => (x.orderItemId ? [x.orderItemId] : [])));
}

const viewInclude = {
  items: { select: { orderItemId: true, quantity: true, orderItem: { select: { productNameSnapshot: true, optionNameSnapshot: true, quantity: true } } }, orderBy: { id: "asc" } },
  images: { select: { id: true, width: true, height: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] },
} satisfies Prisma.ReturnRequestInclude;

type Row = Prisma.ReturnRequestGetPayload<{ include: typeof viewInclude }>;
function view(r: Row) {
  return {
    id: r.id,
    orderId: r.orderId,
    kind: r.kind,
    status: r.status,
    reason: r.reason,
    reasonText: r.reasonText,
    fault: r.fault,
    rejectReason: r.rejectReason,
    returnCourier: r.returnCourier,
    returnCourierName: courierName(r.returnCourier),
    returnTrackingNumber: r.returnTrackingNumber,
    exchangeCourier: r.exchangeCourier,
    exchangeCourierName: courierName(r.exchangeCourier),
    exchangeTrackingNumber: r.exchangeTrackingNumber,
    restocked: r.restocked,
    refundAmount: r.refundAmount,
    pickupMethod: r.pickupMethod,
    inspectionResult: r.inspectionResult,
    inspectionNote: r.inspectionNote,
    inspectedAt: r.inspectedAt,
    exchangeHeldAt: r.exchangeHeldAt,
    convertedFromExchange: r.convertedFromExchange,
    hasRefundAccount: r.refundAccountNumber !== null,
    createdAt: r.createdAt,
    acceptedAt: r.acceptedAt,
    receivedAt: r.receivedAt,
    completedAt: r.completedAt,
    rejectedAt: r.rejectedAt,
    cancelledAt: r.cancelledAt,
    items: r.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity, orderQuantity: i.orderItem.quantity, productName: i.orderItem.productNameSnapshot, optionName: i.orderItem.optionNameSnapshot })),
    // 일부 수량만 반품하는 품목이 있는 신청(재고 자동 복구 대상이 아니다)
    partialQuantity: r.items.some((i) => i.quantity < i.orderItem.quantity),
    images: r.images,
  };
}
export type ReturnView = ReturnType<typeof view>;

// ───────────── 구매자 ─────────────

function buyerAudit(tx: Tx, scope: BuyerScope, meta: AuditMeta, action: string, targetId: string | undefined, after: unknown) {
  return writeAudit(tx, { actorType: "BUYER", actorId: scope.buyerMemberId, sellerId: scope.sellerId, action, targetType: "ReturnRequest", targetId, after, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });
}

// 신청 사진 올리기(리뷰 사진과 같은 검사). 붙지 않은 사진은 회원당 10장까지 두고 오래된 것부터 지운다.
export async function uploadReturnImage(db: PrismaClient, scope: BuyerScope, bytes: Buffer, meta: AuditMeta = {}) {
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  const c = checkReviewImage(bytes);
  if (!c.ok) return c satisfies { ok: false; reason: ReviewImageRejection };
  return db.$transaction(async (tx) => {
    const [member] = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR UPDATE`;
    if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
    const old = await tx.returnRequestImage.findMany({ where: { ...scope, returnRequestId: null }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: UNATTACHED_KEEP - 1, select: { id: true } });
    if (old.length > 0) await returnImageStore.delete(tx, { id: { in: old.map((o) => o.id) } });
    const img = await returnImageStore.put(tx, { ...scope, image: c.image });
    await buyerAudit(tx, scope, meta, "buyer_return.image_upload", undefined, { imageId: img.id, byteSize: c.image.data.length });
    return { ok: true as const, image: img };
  });
}

// 내가 올렸거나 내 신청에 붙은 사진
export async function buyerReturnImage(db: PrismaClient, scope: BuyerScope, imageId: string) {
  if (!isUuid(imageId)) return null;
  return returnImageStore.get(db, { id: imageId, sellerId: scope.sellerId, buyerMemberId: scope.buyerMemberId });
}
// 파트너스가 보는 신청 사진(같은 쇼핑몰 신청에 붙은 사진만)
export async function sellerReturnImage(db: PrismaClient, ctx: TenantContext, imageId: string) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  if (!isUuid(imageId)) return null;
  return returnImageStore.get(db, { id: imageId, sellerId: ctx.sellerId, returnRequestId: { not: null } });
}

// 신청 화면에 필요한 것: 이 주문을 신청할 수 있는지(못 하면 이유), 교환할 품목, 지난·진행 중인 신청
export async function buyerReturnContext(db: PrismaClient, scope: BuyerScope, orderId: string) {
  if (!isUuid(orderId)) return null;
  const order = await db.order.findFirst({
    where: { id: orderId, ...scope, legalHoldAt: null },
    select: {
      status: true,
      purchaseConfirmedAt: true,
      items: { select: { id: true, productNameSnapshot: true, optionNameSnapshot: true, quantity: true, refundedQuantity: true }, orderBy: { id: "asc" } },
      paymentMethod: true,
      shipment: { select: { status: true, deliveredAt: true } },
    },
  });
  if (!order) return null;
  const opened = await openedOrderItemIds(db, scope.sellerId, orderId);
  const deliveredAt = order.shipment?.deliveredAt ?? null;
  // 부분 환불로 다 돌려준 품목은 신청할 수 없고, 수량은 남은 수량(quantity − refundedQuantity)
  const returnable = order.items.filter((i) => i.refundedQuantity < i.quantity);
  const requests = await db.returnRequest.findMany({ where: { sellerId: scope.sellerId, orderId }, include: viewInclude, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const active = requests.find((r) => ACTIVE_STATUSES.includes(r.status)) ?? null;
  const open = await shopOpen(db, scope.sellerId);
  const blocked = !open ? "shop_unavailable" : order.status !== "PAID" || order.shipment?.status !== "DELIVERED" || order.purchaseConfirmedAt ? "not_returnable" : active ? "active_exists" : null;
  return {
    canRequest: blocked === null,
    blocked,
    // 신청 기한(배송 완료 뒤 7일). 지났어도 불량·오배송·설명과 다름 사유는 받는다(windowOpen=false면 단순 변심·기타는 막힌다)
    refunds: (await orderRefundHistory(db, scope.sellerId, orderId)).map(({ seq, createdAt, refundAmount, returnFeeDeducted, rewardReturn, items }) => ({ seq, createdAt, refundAmount, returnFeeDeducted, rewardReturn, items })),
    deadline: returnDeadline(deliveredAt),
    windowOpen: withinReturnWindow(deliveredAt, new Date(), "CHANGE_OF_MIND"),
    needsRefundAccount: order.paymentMethod === "BANK_TRANSFER",
    items: returnable.map((i) => ({ orderItemId: i.id, productName: i.productNameSnapshot, optionName: i.optionNameSnapshot, quantity: i.quantity - i.refundedQuantity, opened: opened.has(i.id) })),
    requests: requests.map(view),
  };
}

export async function createReturn(db: PrismaClient, scope: BuyerScope, orderId: string, body: Record<string, unknown>, meta: AuditMeta = {}) {
  if (!isUuid(orderId)) return { ok: false as const, reason: "not_found" as const };
  const parsed = parseNewReturn(body);
  if (!parsed.ok) return parsed;
  const input = parsed.v;
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  try {
    return await db.$transaction(async (tx) => {
      const locked = await lockOrder(tx, scope.sellerId, orderId);
      if (!locked || locked.buyerMemberId !== scope.buyerMemberId || locked.legalHoldAt) return { ok: false as const, reason: "not_found" as const };
      const [member] = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "BuyerMember" WHERE "id" = ${scope.buyerMemberId}::uuid AND "sellerId" = ${scope.sellerId}::uuid AND "status" = 'ACTIVE' AND "deletedAt" IS NULL FOR SHARE`;
      if (!member) return { ok: false as const, reason: "shop_unavailable" as const };
      const shipment = await tx.shipment.findUnique({ where: { orderId }, select: { status: true, deliveredAt: true } });
      if (locked.status !== "PAID" || shipment?.status !== "DELIVERED" || locked.purchaseConfirmedAt) return { ok: false as const, reason: "not_returnable" as const };
      if (!withinReturnWindow(shipment.deliveredAt, await clockNow(tx), input.reason)) return { ok: false as const, reason: "period_expired" as const };
      if ((await tx.returnRequest.count({ where: { sellerId: scope.sellerId, orderId, status: { in: [...ACTIVE_STATUSES] } } })) > 0) return { ok: false as const, reason: "active_exists" as const };
      // 부분 환불로 다 돌려준 품목은 빼고, 신청 수량은 남은 수량
      const orderItems = (await tx.orderItem.findMany({ where: { sellerId: scope.sellerId, orderId }, select: { id: true, quantity: true, refundedQuantity: true } }))
        .filter((i) => i.refundedQuantity < i.quantity)
        .map((i) => ({ id: i.id, quantity: i.quantity - i.refundedQuantity }));
      let picked: { id: string; quantity: number }[];
      if (input.kind === "RETURN" && input.returnItems) {
        // 부분 반품: 고른 품목이 남은 수량 안에 있어야 한다
        const left = new Map(orderItems.map((i) => [i.id, i.quantity]));
        if (input.returnItems.some((i) => (left.get(i.orderItemId) ?? 0) < i.quantity)) return { ok: false as const, reason: "invalid_items" as const };
        picked = input.returnItems.map((i) => ({ id: i.orderItemId, quantity: i.quantity }));
      } else {
        picked = input.kind === "RETURN" ? orderItems : orderItems.filter((i) => input.orderItemIds!.includes(i.id));
      }
      if (picked.length === 0 || (input.kind === "EXCHANGE" && picked.length !== input.orderItemIds!.length)) return { ok: false as const, reason: "invalid_items" as const };
      // 개봉한 상품은 단순 변심으로 신청할 수 없다. 교환은 고른 품목 중 하나라도, 반품은 모든 품목이 개봉이면 막는다(일부만 개봉한 반품은 개봉분을 뺀 금액으로 환불).
      if (input.reason === "CHANGE_OF_MIND") {
        const opened = await openedOrderItemIds(tx, scope.sellerId, orderId);
        const hits = picked.filter((i) => opened.has(i.id)).length;
        if (hits > 0 && (input.kind === "EXCHANGE" || hits === picked.length)) return { ok: false as const, reason: "opened_blocked" as const };
      }
      // 무통장 입금 주문은 환불 계좌가 있어야 신청할 수 있다
      const paid = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { paymentMethod: true } });
      if (paid.paymentMethod === "BANK_TRANSFER" && !input.refundAccount) return { ok: false as const, reason: "refund_account_required" as const };
      // 계좌번호는 원문으로 저장하지 않는다(빌링키와 같은 AES-256-GCM 봉인, 쇼핑몰 id 묶음). 비밀키가 없으면 신청을 받지 않는다.
      if (paid.paymentMethod === "BANK_TRANSFER") {
        try {
          assertBillingSecret();
        } catch {
          return { ok: false as const, reason: "refund_account_unavailable" as const };
        }
      }
      const imgs = input.imageIds.length
        ? await tx.returnRequestImage.findMany({ where: { id: { in: input.imageIds }, ...scope, returnRequestId: null }, select: { id: true } })
        : [];
      if (imgs.length !== input.imageIds.length) return { ok: false as const, reason: "invalid_images" as const };
      const created = await tx.returnRequest.create({
        data: {
          sellerId: scope.sellerId,
          orderId,
          buyerMemberId: scope.buyerMemberId,
          kind: input.kind,
          reason: input.reason,
          reasonText: input.reasonText,
          pickupMethod: input.pickup,
          ...(paid.paymentMethod === "BANK_TRANSFER" && input.refundAccount
            ? { refundBankName: input.refundAccount.bankName, refundAccountHolder: input.refundAccount.accountHolder, refundAccountNumber: sealBillingKey(input.refundAccount.accountNumber, scope.sellerId) }
            : {}),
        },
        select: { id: true },
      });
      await tx.returnRequestItem.createMany({ data: picked.map((i) => ({ sellerId: scope.sellerId, returnRequestId: created.id, orderItemId: i.id, quantity: i.quantity })) });
      for (const [index, id] of input.imageIds.entries()) {
        await tx.returnRequestImage.update({ where: { id }, data: { returnRequestId: created.id, sortOrder: index } });
      }
      await buyerAudit(tx, scope, meta, "buyer_return.create", created.id, { orderId, kind: input.kind, reason: input.reason, items: picked.length, images: input.imageIds.length });
      const row = await tx.returnRequest.findUniqueOrThrow({ where: { id: created.id }, include: viewInclude });
      return { ok: true as const, request: view(row) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false as const, reason: "active_exists" as const };
    throw e;
  }
}

// 구매자 철회: 신청·접수 단계만(회수가 끝났거나 닫힌 신청은 못 함)
export async function buyerCancelReturn(db: PrismaClient, scope: BuyerScope, id: string, meta: AuditMeta = {}) {
  return buyerStep(db, scope, id, "cancel", meta, async (tx, r, now) => {
    await tx.returnRequest.update({ where: { id: r.id }, data: { status: "CANCELLED", cancelledAt: now, updatedAt: now, ...CLEAR_ACCOUNT } });
    await buyerAudit(tx, scope, meta, "buyer_return.cancel", r.id, { from: r.status });
  });
}

// 구매자가 돌려보낸 송장 입력(접수 단계)
export async function buyerShipBack(db: PrismaClient, scope: BuyerScope, id: string, body: Record<string, unknown>, meta: AuditMeta = {}) {
  const t = parseTracking(body);
  if (!t.ok) return t;
  return buyerStep(db, scope, id, "shipBack", meta, async (tx, r, now) => {
    await tx.returnRequest.update({ where: { id: r.id }, data: { returnCourier: t.courier, returnTrackingNumber: t.trackingNumber, updatedAt: now } });
    await buyerAudit(tx, scope, meta, "buyer_return.ship_back", r.id, { courier: t.courier });
  });
}

async function buyerStep(
  db: PrismaClient,
  scope: BuyerScope,
  id: string,
  step: keyof typeof TRANSITIONS,
  _meta: AuditMeta,
  body: (tx: Tx, r: NonNullable<Awaited<ReturnType<typeof lockRequest>>>, now: Date) => Promise<void>,
) {
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  if (!(await shopOpen(db, scope.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  return db.$transaction(async (tx) => {
    const pre = await tx.returnRequest.findFirst({ where: { id, ...scope }, select: { orderId: true } });
    if (!pre) return { ok: false as const, reason: "not_found" as const };
    await lockOrder(tx, scope.sellerId, pre.orderId);
    const r = await lockRequest(tx, scope.sellerId, id);
    if (!r || r.buyerMemberId !== scope.buyerMemberId) return { ok: false as const, reason: "not_found" as const };
    if (!TRANSITIONS[step].includes(r.status)) return { ok: false as const, reason: "invalid_transition" as const };
    await body(tx, r, await clockNow(tx));
    const row = await tx.returnRequest.findUniqueOrThrow({ where: { id }, include: viewInclude });
    return { ok: true as const, request: view(row) };
  });
}

// ───────────── 파트너스 ─────────────

const STATUS_FILTER = new Set<string>(["REQUESTED", "ACCEPTED", "RECEIVED", "COMPLETED", "REJECTED", "CANCELLED"]);

// 목록·상태별 건수. ?status, ?kind, 커서(createdAt 내림, id 내림). 접수 대기 건수가 위쪽 요약에 쓰인다.
export async function listSellerReturns(db: PrismaClient, ctx: TenantContext, q: { status?: unknown; kind?: unknown; cursor?: unknown } = {}) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const status = typeof q.status === "string" && STATUS_FILTER.has(q.status) ? (q.status as ReturnStatus) : undefined;
  const kind = q.kind === "RETURN" || q.kind === "EXCHANGE" ? q.kind : undefined;
  let after: Prisma.ReturnRequestWhereInput = {};
  if (typeof q.cursor === "string" && isUuid(q.cursor)) {
    const c = await db.returnRequest.findFirst({ where: { id: q.cursor, sellerId: ctx.sellerId }, select: { id: true, createdAt: true } });
    if (c) after = { OR: [{ createdAt: { lt: c.createdAt } }, { createdAt: c.createdAt, id: { lt: c.id } }] };
  }
  const where = { sellerId: ctx.sellerId, ...(status ? { status } : {}), ...(kind ? { kind } : {}), ...after } satisfies Prisma.ReturnRequestWhereInput;
  const rows = await db.returnRequest.findMany({
    where,
    include: { ...viewInclude, order: { select: { orderNo: true, createdAt: true, broadcastNicknameSnapshot: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE + 1,
  });
  const page = rows.slice(0, PAGE);
  const counts = await db.returnRequest.groupBy({ by: ["status"], where: { sellerId: ctx.sellerId }, _count: { _all: true } });
  const summary = await returnSummary(db, ctx.sellerId);
  return {
    summary,
    returns: page.map((r) => ({ ...view(r), orderNo: r.order.orderNo, orderNoLabel: orderNoLabel(r.order.createdAt, r.order.orderNo), nickname: r.order.broadcastNicknameSnapshot })),
    nextCursor: rows.length > PAGE ? page[page.length - 1].id : null,
    counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])) as Partial<Record<ReturnStatus, number>>,
  };
}

// 요약 카드(SA-029): 접수 대기, 수거·검수 중, 이번 달(KST) 완료 반품·교환, 최근 30일 반품률(철회·거절을 뺀 반품 신청 ÷ 배송 완료 주문)
async function returnSummary(db: PrismaClient, sellerId: string) {
  const [row] = await db.$queryRaw<{ requested: bigint; inProgress: bigint; doneReturn: bigint; doneExchange: bigint; returns30: bigint; delivered30: bigint }[]>`
    SELECT
      (SELECT count(*) FROM "ReturnRequest" WHERE "sellerId" = ${sellerId}::uuid AND "status" = 'REQUESTED') AS "requested",
      (SELECT count(*) FROM "ReturnRequest" WHERE "sellerId" = ${sellerId}::uuid AND "status" IN ('ACCEPTED', 'RECEIVED')) AS "inProgress",
      (SELECT count(*) FROM "ReturnRequest" WHERE "sellerId" = ${sellerId}::uuid AND "status" = 'COMPLETED' AND "kind" = 'RETURN'
         AND date_trunc('month', "completedAt" AT TIME ZONE 'Asia/Seoul') = date_trunc('month', now() AT TIME ZONE 'Asia/Seoul')) AS "doneReturn",
      (SELECT count(*) FROM "ReturnRequest" WHERE "sellerId" = ${sellerId}::uuid AND "status" = 'COMPLETED' AND "kind" = 'EXCHANGE'
         AND date_trunc('month', "completedAt" AT TIME ZONE 'Asia/Seoul') = date_trunc('month', now() AT TIME ZONE 'Asia/Seoul')) AS "doneExchange",
      (SELECT count(*) FROM "ReturnRequest" WHERE "sellerId" = ${sellerId}::uuid AND "kind" = 'RETURN' AND "convertedFromExchange" = false AND "status" NOT IN ('CANCELLED', 'REJECTED') AND "createdAt" >= now() - interval '30 days') AS "returns30",
      (SELECT count(*) FROM "Shipment" WHERE "sellerId" = ${sellerId}::uuid AND "status" = 'DELIVERED' AND "deliveredAt" >= now() - interval '30 days') AS "delivered30"`;
  const delivered = Number(row.delivered30);
  return {
    requested: Number(row.requested),
    inProgress: Number(row.inProgress),
    doneReturn: Number(row.doneReturn),
    doneExchange: Number(row.doneExchange),
    // 소수 첫째 자리(%). 배송 완료 주문이 없으면 null
    returnRate30: delivered === 0 ? null : Math.round((Number(row.returns30) / delivered) * 1000) / 10,
  };
}

// 상세: 신청 + 주문 요약 + (반품이 진행 중이면) 환불 미리보기와 환불 화면이 보낼 버전
export async function getSellerReturn(db: PrismaClient, ctx: TenantContext, id: string) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  if (!isUuid(id)) return null;
  const r = await db.returnRequest.findFirst({
    where: { id, sellerId: ctx.sellerId },
    include: { ...viewInclude, order: { select: { orderNo: true, createdAt: true, status: true, totalAmount: true, shippingFee: true, paymentMethod: true, broadcastNicknameSnapshot: true, purchaseConfirmedAt: true, shipment: { select: { courier: true, trackingNumber: true, deliveredAt: true } } } } },
  });
  if (!r) return null;
  const refundable = r.kind === "RETURN" && (r.status === "ACCEPTED" || r.status === "RECEIVED");
  // 환불은 신청한 품목·수량만(부분 반품, 교환에서 전환한 환불 포함)
  const preview = refundable ? await previewRefundSelection(db, ctx, r.orderId, requestSelection(r.items)) : null;
  const refunds = await orderRefundHistory(db, ctx.sellerId, r.orderId);
  return {
    ...view(r),
    // 무통장 환불 계좌(환불·종료 뒤 비워진다). 파트너스만 본다
    refundAccount: r.refundAccountNumber ? { bankName: r.refundBankName, accountHolder: r.refundAccountHolder, accountNumber: openAccountNumber(r.refundAccountNumber, ctx.sellerId) } : null,
    paymentMethod: r.order.paymentMethod,
    refunds,
    orderNo: r.order.orderNo,
    orderNoLabel: orderNoLabel(r.order.createdAt, r.order.orderNo),
    nickname: r.order.broadcastNicknameSnapshot,
    order: { status: r.order.status, totalAmount: r.order.totalAmount, shippingFee: r.order.shippingFee, purchaseConfirmed: r.order.purchaseConfirmedAt !== null, shipment: r.order.shipment },
    refundPreview: preview?.ok ? preview.value : null,
    queueVersion: refundable ? await getRefundVersion(db, ctx) : null,
  };
}

// 이 주문에서 지금까지 한 환불(부분 환불 포함) 내역. 품목은 그때 기록한 수량·이름.
async function orderRefundHistory(db: Db, sellerId: string, orderId: string) {
  const [refunds, items] = await Promise.all([
    db.orderRefund.findMany({ where: { sellerId, orderId }, orderBy: { seq: "asc" } }),
    db.orderItem.findMany({ where: { sellerId, orderId }, select: { id: true, productNameSnapshot: true, optionNameSnapshot: true } }),
  ]);
  const name = new Map(items.map((i) => [i.id, i]));
  return refunds.map((r) => ({
    seq: r.seq,
    createdAt: r.createdAt,
    refundAmount: r.refundAmount,
    shippingRefunded: r.shippingRefunded,
    returnFeeDeducted: r.returnFeeDeducted,
    rewardReturn: r.rewardReturn,
    isFinal: r.isFinal,
    items: (Array.isArray(r.items) ? (r.items as { orderItemId: string; quantity: number }[]) : []).map((l) => ({
      quantity: l.quantity,
      productName: name.get(l.orderItemId)?.productNameSnapshot ?? "",
      optionName: name.get(l.orderItemId)?.optionNameSnapshot ?? "",
    })),
  }));
}

// 파트너스 상세에서만 환불 계좌번호를 푼다(목록·구매자 응답·로그 추적에는 값이 없다). 봉인 전에 저장된 값(원문)은 그대로 보여 주고, 풀 수 없으면 null.
function openAccountNumber(stored: string, sellerId: string): string | null {
  if (!stored.startsWith("v1.")) return stored;
  try {
    return openBillingKey(stored, sellerId);
  } catch {
    return null;
  }
}

const requestSelection = (items: { orderItemId: string; quantity: number }[]): RefundSelection => items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity }));

type Step = (tx: Tx, r: NonNullable<Awaited<ReturnType<typeof lockRequest>>>, now: Date, order: NonNullable<Awaited<ReturnType<typeof lockOrder>>>) => Promise<{ ok: false; reason: ReturnFailure } | void>;

// 파트너스 전이 공통: 권한 → 주문 잠금 → 신청 잠금 → 단계 확인 → 주문이 아직 결제 완료인지 확인 → 본문
async function sellerStep(db: PrismaClient, ctx: TenantContext, id: string, step: keyof typeof TRANSITIONS, body: Step) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  return db.$transaction(async (tx) => {
    const pre = await tx.returnRequest.findFirst({ where: { id, sellerId: ctx.sellerId }, select: { orderId: true } });
    if (!pre) return { ok: false as const, reason: "not_found" as const };
    const order = await lockOrder(tx, ctx.sellerId, pre.orderId);
    const r = await lockRequest(tx, ctx.sellerId, id);
    if (!order || !r) return { ok: false as const, reason: "not_found" as const };
    if (!TRANSITIONS[step].includes(r.status)) return { ok: false as const, reason: "invalid_transition" as const };
    if (order.status !== "PAID") return { ok: false as const, reason: "not_returnable" as const };
    const failed = await body(tx, r, await clockNow(tx), order);
    if (failed) return failed;
    const row = await tx.returnRequest.findUniqueOrThrow({ where: { id }, include: viewInclude });
    return { ok: true as const, request: view(row) };
  });
}

const sellerAudit = (tx: Tx, ctx: TenantContext, action: string, id: string, before: unknown, after: unknown, reason?: string) =>
  writeAudit(tx, { actorType: ctx.actorType as ActorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "ReturnRequest", targetId: id, before, after, reason });

// 접수: 신청 → 접수. 사유 주체를 정한다(구매자 사정이면 반품 배송비를 받는다). 사유가 「기타」면 꼭 보내야 한다.
export async function acceptReturn(db: PrismaClient, ctx: TenantContext, id: string, body: { fault?: unknown; pickup?: unknown }) {
  if (body.fault !== undefined && body.fault !== null && parseFault(body.fault) === null) return { ok: false as const, reason: "invalid_fault" as const };
  // 수거 방법: 보내지 않으면 구매자가 신청 때 고른 희망을 그대로 쓴다
  const pickup = body.pickup === undefined || body.pickup === null ? null : parsePickup(body.pickup);
  if (body.pickup !== undefined && body.pickup !== null && !pickup) return { ok: false as const, reason: "invalid_pickup" as const };
  return sellerStep(db, ctx, id, "accept", async (tx, r, now) => {
    const fault = parseFault(body.fault) ?? DEFAULT_FAULT[r.reason];
    if (!fault) return { ok: false, reason: "fault_required" };
    await tx.returnRequest.update({ where: { id: r.id }, data: { status: "ACCEPTED", acceptedAt: now, fault, updatedAt: now, ...(pickup ? { pickupMethod: pickup } : {}) } });
    await sellerAudit(tx, ctx, "return.accept", r.id, { status: r.status }, { status: "ACCEPTED", fault, pickup: pickup ?? undefined });
  });
}

// 거절: 신청 단계만. 사유 필수(구매자에게 보인다).
export async function rejectReturn(db: PrismaClient, ctx: TenantContext, id: string, body: { reason?: unknown }) {
  const reason = parseRejectReason(body.reason);
  if (!reason) return { ok: false as const, reason: "invalid_reject_reason" as const };
  return sellerStep(db, ctx, id, "reject", async (tx, r, now) => {
    await tx.returnRequest.update({ where: { id: r.id }, data: { status: "REJECTED", rejectedAt: now, rejectReason: reason, updatedAt: now, ...CLEAR_ACCOUNT } });
    await sellerAudit(tx, ctx, "return.reject", r.id, { status: r.status }, { status: "REJECTED" }, reason);
  });
}

// 입고 확인: 접수 → 회수 완료(검수 중). 재고는 여기서 되돌리지 않는다. 검수에서 이상 없음이 나온 뒤에만 되돌린다(inspectReturn restock).
export async function receiveReturn(db: PrismaClient, ctx: TenantContext, id: string, _body: Record<string, unknown> = {}) {
  return sellerStep(db, ctx, id, "receive", async (tx, r, now) => {
    await tx.returnRequest.update({ where: { id: r.id }, data: { status: "RECEIVED", receivedAt: now, updatedAt: now } });
    await sellerAudit(tx, ctx, "return.receive", r.id, { status: r.status }, { status: "RECEIVED" });
  });
}

// 검수 결과 입력: 회수 완료(검수 중) 단계에서. 이상 없음이어야 환불·교환 발송으로 넘어가고, 그 밖은 반송·거절(rejectInspected)을 고른다. 다시 입력해 고칠 수 있다.
// restock: 이상 없음일 때만 이 신청의 품목 재고를 되돌린다(판매자 설정 「취소·반품 때 재고 복구」가 꺼져 있으면 되돌리지 않는다). 되돌린 뒤에는 검수 결과를 문제 있음으로 바꿀 수 없다(재고가 이미 늘어 있어서).
export async function inspectReturn(db: PrismaClient, ctx: TenantContext, id: string, body: { result?: unknown; note?: unknown; restock?: unknown }) {
  const result = parseInspection(body.result);
  if (!result) return { ok: false as const, reason: "invalid_inspection" as const };
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null && body.note !== "") {
    note = cleanText(body.note, INSPECTION_NOTE_MAX, "memo");
    if (note === null) return { ok: false as const, reason: "invalid_inspection" as const };
  }
  return sellerStep(db, ctx, id, "inspect", async (tx, r, now) => {
    const cur = await tx.returnRequest.findUniqueOrThrow({ where: { id: r.id }, select: { restocked: true } });
    if (cur.restocked && result !== "OK") return { ok: false, reason: "inspection_locked" };
    let restockedItems = 0;
    if (result === "OK" && body.restock === true && !cur.restocked) {
      // 재고 복구(products/stock.ts)는 품목의 주문 수량 전체를 되돌린다. 일부 수량만 반품한 품목은 되돌리지 않는다(파트너스가 재고 조정에서 직접 맞춘다).
      const items = await tx.returnRequestItem.findMany({ where: { sellerId: ctx.sellerId, returnRequestId: r.id }, select: { orderItemId: true, quantity: true, orderItem: { select: { quantity: true } } } });
      const whole = items.filter((i) => i.quantity === i.orderItem.quantity);
      const restored = whole.length === 0 ? [] : await restoreOrderStock(tx, { sellerId: ctx.sellerId, orderId: r.orderId, reason: "REFUND", now, actor: { actorType: ctx.actorType as ActorType, actorId: ctx.actorId }, itemIds: whole.map((i) => i.orderItemId) });
      restockedItems = restored.length;
    }
    await tx.returnRequest.update({ where: { id: r.id }, data: { inspectionResult: result, inspectionNote: note, inspectedAt: now, updatedAt: now, ...(restockedItems > 0 ? { restocked: true } : {}) } });
    await sellerAudit(tx, ctx, "return.inspect", r.id, { status: r.status }, { result, restockedItems }, note ?? undefined);
  });
}

// 검수에서 문제가 확인된 건 반송·거절: 검수 결과가 이상 없음이 아닐 때만. 사유 필수(구매자에게 보인다). 실제 반송은 판매자가 따로 한다.
export async function rejectInspectedReturn(db: PrismaClient, ctx: TenantContext, id: string, body: { reason?: unknown }) {
  const reason = parseRejectReason(body.reason);
  if (!reason) return { ok: false as const, reason: "invalid_reject_reason" as const };
  return sellerStep(db, ctx, id, "rejectInspected", async (tx, r, now) => {
    const cur = await tx.returnRequest.findUniqueOrThrow({ where: { id: r.id }, select: { inspectionResult: true } });
    if (cur.inspectionResult === null) return { ok: false, reason: "inspection_required" };
    if (cur.inspectionResult === "OK") return { ok: false, reason: "wrong_kind" };
    await tx.returnRequest.update({ where: { id: r.id }, data: { status: "REJECTED", rejectedAt: now, rejectReason: reason, updatedAt: now, ...CLEAR_ACCOUNT } });
    await sellerAudit(tx, ctx, "return.reject_inspected", r.id, { status: r.status }, { status: "REJECTED", inspection: cur.inspectionResult }, reason);
  });
}

// 교환 재고 없음 처리 ①재입고 뒤 발송: 보류 표시만 남기고 단계는 그대로(재고가 들어오면 교환 발송). 교환만, 검수 이상 없음 뒤.
export async function holdExchange(db: PrismaClient, ctx: TenantContext, id: string) {
  return sellerStep(db, ctx, id, "hold", async (tx, r, now) => {
    if (r.kind !== "EXCHANGE") return { ok: false, reason: "wrong_kind" };
    const cur = await tx.returnRequest.findUniqueOrThrow({ where: { id: r.id }, select: { inspectionResult: true } });
    if (cur.inspectionResult !== "OK") return { ok: false, reason: cur.inspectionResult === null ? "inspection_required" : "inspection_not_ok" };
    await tx.returnRequest.update({ where: { id: r.id }, data: { exchangeHeldAt: now, updatedAt: now } });
    await sellerAudit(tx, ctx, "return.exchange_hold", r.id, { status: r.status }, { heldAt: now.toISOString() });
  });
}

// 교환 재고 없음 처리 ②환불로 전환: 교환 신청을 반품(신청한 품목만 환불)으로 바꾼다. 환불 금액은 반품 환불 화면에서 확인받고 실행한다.
// 환불은 사유 주체(접수 때 정함)를 따른다. 무통장 주문이면 신청 때 받은 환불 계좌가 필요하다.
export async function convertExchangeToRefund(db: PrismaClient, ctx: TenantContext, id: string) {
  return sellerStep(db, ctx, id, "convert", async (tx, r, now) => {
    if (r.kind !== "EXCHANGE") return { ok: false, reason: "wrong_kind" };
    const cur = await tx.returnRequest.findUniqueOrThrow({ where: { id: r.id }, select: { inspectionResult: true, refundAccountNumber: true, order: { select: { paymentMethod: true } } } });
    if (cur.inspectionResult !== "OK") return { ok: false, reason: cur.inspectionResult === null ? "inspection_required" : "inspection_not_ok" };
    if (cur.order.paymentMethod === "BANK_TRANSFER" && !cur.refundAccountNumber) return { ok: false, reason: "refund_account_required" };
    await tx.returnRequest.update({ where: { id: r.id }, data: { kind: "RETURN", convertedFromExchange: true, exchangeHeldAt: null, updatedAt: now } });
    await sellerAudit(tx, ctx, "return.exchange_to_refund", r.id, { kind: "EXCHANGE" }, { kind: "RETURN" });
  });
}

// 교환 발송: 회수 완료 → 완료(교환만). 교환 상품 재고를 빼고(부족하면 아무것도 바꾸지 않음) 송장을 남긴다.
export async function shipExchange(db: PrismaClient, ctx: TenantContext, id: string, body: Record<string, unknown>) {
  const t = parseTracking(body);
  if (!t.ok) return t;
  return sellerStep(db, ctx, id, "complete", async (tx, r, now) => {
    if (r.kind !== "EXCHANGE") return { ok: false, reason: "wrong_kind" };
    const insp = await tx.returnRequest.findUniqueOrThrow({ where: { id: r.id }, select: { inspectionResult: true } });
    if (insp.inspectionResult !== "OK") return { ok: false, reason: insp.inspectionResult === null ? "inspection_required" : "inspection_not_ok" };
    const items = await tx.returnRequestItem.findMany({ where: { sellerId: ctx.sellerId, returnRequestId: r.id }, select: { orderItemId: true, quantity: true, orderItem: { select: { optionId: true } } } });
    // 옵션 id 순서로 잠가 같은 옵션을 다루는 다른 교환·주문과 교착하지 않게 한다. 수량은 신청 수량(부분 환불한 수량을 뺀 값)
    const need = new Map<string, number>();
    for (const i of items) need.set(i.orderItem.optionId, (need.get(i.orderItem.optionId) ?? 0) + i.quantity);
    for (const [optionId, qty] of [...need.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const dec = await tx.productOption.updateMany({ where: { id: optionId, sellerId: ctx.sellerId, stock: { gte: qty } }, data: { stock: { decrement: qty } } });
      if (dec.count !== 1) throw new StockShort();
      await tx.stockMovement.create({ data: { sellerId: ctx.sellerId, optionId, delta: -qty, reason: "EXCHANGE", orderId: r.orderId, actorType: ctx.actorType as ActorType, actorId: ctx.actorId, createdAt: now } });
    }
    // 교환 상품이 다시 나갔으니, 회수 때 되돌린 표시(stockRestoredAt)를 풀어 이 품목을 뒤에 다시 반품·환불로 회수할 때 재고를 한 번 더 되돌릴 수 있게 한다
    await tx.orderItem.updateMany({ where: { sellerId: ctx.sellerId, id: { in: items.map((i) => i.orderItemId) }, stockRestoredAt: { not: null } }, data: { stockRestoredAt: null } });
    await tx.returnRequest.update({ where: { id: r.id }, data: { status: "COMPLETED", completedAt: now, exchangeCourier: t.courier, exchangeTrackingNumber: t.trackingNumber, exchangeHeldAt: null, updatedAt: now } });
    await sellerAudit(tx, ctx, "return.exchange_ship", r.id, { status: r.status }, { status: "COMPLETED", courier: t.courier, optionCount: need.size });
  }).catch((e) => {
    if (e instanceof StockShort) return { ok: false as const, reason: "insufficient_stock" as const };
    throw e;
  });
}
class StockShort extends Error {}

// 반품 환불: 회수 완료 → 기존 환불(refundOrder) 호출. 확인받은 금액(expectedRefundAmount)과 화면이 본 버전(expectedVersion)으로만 실행한다.
// 환불 트랜잭션 안에서 신청이 완료로 닫힌다(closeReturnsOnRefund).
export async function refundReturn(
  db: PrismaClient,
  ctx: TenantContext,
  id: string,
  body: { expectedVersion: number; expectedRefundAmount: number; confirmOpened?: boolean },
) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!isUuid(id)) return { ok: false as const, reason: "not_found" as const };
  const r = await db.returnRequest.findFirst({
    where: { id, sellerId: ctx.sellerId },
    select: { orderId: true, kind: true, status: true, fault: true, inspectionResult: true, convertedFromExchange: true, refundAccountNumber: true, order: { select: { paymentMethod: true } }, items: { select: { orderItemId: true, quantity: true } } },
  });
  if (!r) return { ok: false as const, reason: "not_found" as const };
  if (r.kind !== "RETURN") return { ok: false as const, reason: "wrong_kind" as const };
  if (r.status !== "RECEIVED" || !r.fault) return { ok: false as const, reason: "invalid_transition" as const };
  if (r.inspectionResult === null) return { ok: false as const, reason: "inspection_required" as const };
  if (r.inspectionResult !== "OK") return { ok: false as const, reason: "inspection_not_ok" as const };
  if (r.order.paymentMethod === "BANK_TRANSFER" && !r.refundAccountNumber) return { ok: false as const, reason: "refund_account_required" as const };
  const out = await refundOrder(db, ctx, r.orderId, {
    items: requestSelection(r.items),
    reason: "반품 환불",
    expectedLiveVersion: body.expectedVersion,
    confirmOpened: body.confirmOpened === true,
    fault: r.fault,
    expectedRefundAmount: body.expectedRefundAmount,
  });
  if (!out.ok) return { ok: false as const, reason: out.reason, refund: true as const };
  // 전체 환불이 아니면(환불로 전환한 부분 환불) 환불 트랜잭션의 자동 닫기가 돌지 않으므로 여기서 완료로 닫는다(이미 닫혔으면 건드리지 않는다)
  await db.returnRequest.updateMany({ where: { id, sellerId: ctx.sellerId, status: "RECEIVED" }, data: { status: "COMPLETED", completedAt: new Date(), refundAmount: out.value.refundAmount, updatedAt: new Date(), ...CLEAR_ACCOUNT } });
  const row = await db.returnRequest.findUniqueOrThrow({ where: { id }, include: viewInclude });
  return { ok: true as const, request: view(row), refund: out.value, version: out.version };
}
