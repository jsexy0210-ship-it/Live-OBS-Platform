import type { OrderStatus, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { orderNoLabel, parseOrderNoLabel } from "./orderNoLabel";
import { notFound } from "../authz/errors";
import { canViewCustomerPii, requireSellerRead, type TenantContext } from "../tenant/context";
import { thumbnailUrls } from "../products/images";
import { getImage } from "../storage";

// 판매자 범위 조회의 기준 예시. where에는 항상 ctx.sellerId가 들어가고, 다른 판매자 주문은 없음(404)으로 처리한다.
// 구매자 이름·연락처(·주소)는 CUSTOMER_PII_VIEW가 있을 때만 응답에 넣고, 넣었으면 열람 기록을 남긴다
// (화면에서 가리는 것으로는 부족하다, 대표님 결정 2026-10-02).
// 탈퇴 회원의 법정 보관으로 분리한 주문(legalHoldAt, buyers/legalHold.ts)은 일반 조회(상세·목록·검색)에서 없는 주문으로 다룬다.
export async function getOrder(db: PrismaClient, ctx: TenantContext, orderId: string) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const pii = canViewCustomerPii(ctx);
  const order = await db.order.findFirst({
    where: { id: orderId, sellerId: ctx.sellerId, legalHoldAt: null },
    include: {
      items: true,
      couponRedemption: { select: { benefit: true, discountAmount: true, restoredAt: true, coupon: { select: { id: true, name: true } } } },
      shipment: { select: { courier: true, trackingNumber: true, status: true, shippedAt: true, deliveredAt: true } },
      shippingAddress: { select: { recipientName: true, phone: true, zipCode: true, address1: true, address2: true, memo: true, isRemote: true } },
      buyerMember: { select: { id: true, broadcastNickname: true, name: true, phone: true } },
      payments: {
        where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, provider: true, method: true, status: true, amount: true, cancelledAmount: true, pgTid: true,
          cardName: true, cardLast4: true, cardInstallment: true, approvedAt: true, cancelledAt: true, createdAt: true },
      },
      receiptRequests: {
        where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true, kind: true, createdAt: true, withdrawnAt: true, issues: {
          where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: { id: true, status: true, amount: true, issuedAt: true, cancelledAt: true, createdAt: true },
        } },
      },
      consents: { where: { sellerId: ctx.sellerId }, select: { kind: true, noticeVersion: true, agreedAt: true }, orderBy: { agreedAt: "asc" } },
      notifications: {
        where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, kind: true, status: true, claimedAt: true, sentAt: true, createdAt: true, attempts: true },
      },
      queueItems: {
        where: { sellerId: ctx.sellerId }, orderBy: [{ position: "asc" }, { receivedAt: "asc" }, { id: "asc" }],
        select: { id: true, orderItemId: true, status: true, position: true, receivedAt: true,
          openingStartedAt: true, doneAt: true, cancelledAt: true,
          broadcastSession: { select: { id: true, title: true, status: true, startedAt: true } },
          hitCards: { where: { sellerId: ctx.sellerId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            select: { id: true, cardName: true, grade: true, createdAt: true, ...(pii ? { note: true } : {}) } },
        },
      },
    },
  });
  if (!order) throw notFound();

  const { buyerMember, shippingAddress, queueItems, notifications, ...orderRest } = order;
  const waitingIds = queueItems.filter((q) => q.status === "WAITING").map((q) => q.id);
  const [images, aheadRows, mails] = await Promise.all([
    thumbnailUrls(db, ctx.sellerId, [...new Set(order.items.map((i) => i.productId))]),
    waitingIds.length ? db.$queryRaw<{ id: string; ahead: number }[]>`
      SELECT q."id", (SELECT count(*)::int FROM "QueueItem" w
        WHERE w."sellerId" = q."sellerId" AND w."status" = 'WAITING'
          AND w."broadcastSessionId" IS NOT DISTINCT FROM q."broadcastSessionId"
          AND (w."position", w."receivedAt", w."id") < (q."position", q."receivedAt", q."id")) AS "ahead"
      FROM "QueueItem" q WHERE q."sellerId" = ${ctx.sellerId}::uuid AND q."orderId" = ${orderId}::uuid AND q."id" = ANY(${waitingIds}::uuid[])`
      : Promise.resolve([]),
    db.mailDelivery.findMany({
      where: { sellerId: ctx.sellerId, OR: [
        { kind: { in: ["order.pending_bank", "order.paid", "order.shipped", "order.delivered"] }, refId: orderId },
        { kind: "order.refund", refId: { startsWith: `${orderId}:` } },
      ] },
      select: { id: true, kind: true, status: true, createdAt: true, finishedAt: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  ]);
  const ahead = new Map(aheadRows.map((q) => [q.id, q.ahead]));
  const queueByItem = new Map(queueItems.map(({ orderItemId, hitCards, ...q }) => [orderItemId, {
    ...q, aheadCount: q.status === "WAITING" ? ahead.get(q.id) ?? 0 : null,
    waitingNumber: q.status === "WAITING" ? (ahead.get(q.id) ?? 0) + 1 : null,
  }]));
  // 품목마다 보낼 수량(수량 − 부분 환불한 수량). 화면은 refundedQuantity로 「부분 환불 n개」를 보여 준다.
  const rest = { ...orderRest, orderNoLabel: orderNoLabel(order.createdAt, order.orderNo),
    items: order.items.map((i) => ({ ...i, shipQuantity: i.quantity - i.refundedQuantity,
      imageUrl: images.has(i.productId) ? `/api/seller/orders/${order.id}/items/${i.id}/image` : null, queue: queueByItem.get(i.id) ?? null })),
    hitCards: queueItems.flatMap((q) => q.hitCards.map((hit) => ({ ...hit, queueItemId: q.id }))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)),
    notifications: [
      ...notifications.map((n) => ({ ...n, source: "ORDER_NOTIFICATION" as const, channel: null })),
      ...mails.map(({ finishedAt, ...m }) => ({ ...m, source: "MAIL_DELIVERY" as const, channel: "EMAIL" as const, sentAt: m.status === "SENT" ? finishedAt : null })),
    ].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)),
  };
  if (!pii) {
    // 배송지도 개인정보라 도서산간 여부(배송비 근거)만 남긴다
    return {
      ...rest,
      shippingAddress: shippingAddress ? { isRemote: shippingAddress.isRemote } : null,
      buyer: { id: buyerMember.id, broadcastNickname: buyerMember.broadcastNickname },
    };
  }
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "customer.pii.view",
    targetType: "Order",
    targetId: order.id,
  });
  return { ...rest, shippingAddress, buyer: buyerMember };
}

// 주문 처리 담당자가 주문 소속 상품 사진만 읽는다. 상품 관리·공개 쇼핑몰 권한으로 우회하지 않는다.
export async function getOrderItemImage(db: PrismaClient, ctx: TenantContext, orderId: string, itemId: string) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const item = await db.orderItem.findFirst({
    where: { id: itemId, orderId, sellerId: ctx.sellerId, order: { legalHoldAt: null }, product: { deletedAt: null } },
    select: { productId: true },
  });
  if (!item) throw notFound();
  const image = await db.productImage.findFirst({
    where: { sellerId: ctx.sellerId, productId: item.productId, kind: "GALLERY" },
    orderBy: [{ thumbnail: "desc" }, { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { storageKey: true },
  });
  return image ? getImage(db, image.storageKey, ctx.sellerId) : null;
}

export async function listOrders(
  db: PrismaClient,
  ctx: TenantContext,
  opts: { status?: OrderStatus; take?: number } = {},
) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  return db.order.findMany({
    where: { sellerId: ctx.sellerId, legalHoldAt: null, ...(opts.status ? { status: opts.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: Math.min(opts.take ?? 50, 200),
  });
}

// 목록의 품목 요약. 부분 환불로 다 돌려준 품목은 빼고(남은 품목이 없는 환불 주문은 전부로) 첫 상품 이름과 나머지 품목 수, 환불한 수량 합을 준다.
export const itemSummarySelect = { select: { productNameSnapshot: true, quantity: true, refundedQuantity: true }, orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] };
export function itemSummary(items: { productNameSnapshot: string; quantity: number; refundedQuantity: number }[]) {
  const left = items.filter((i) => i.refundedQuantity < i.quantity);
  const shown = left.length ? left : items;
  return {
    firstProductName: shown[0]?.productNameSnapshot ?? null,
    otherCount: Math.max(shown.length - 1, 0),
    refundedQuantity: items.reduce((a, i) => a + i.refundedQuantity, 0),
  };
}

type ShipmentRow = { status: "READY" | "IN_TRANSIT" | "DELIVERED"; courier: string; trackingNumber: string; deliveredAt: Date | null } | null;
function shipmentView(s: ShipmentRow) {
  if (!s || s.status === "READY") return { state: "none" as const, courier: null, trackingNumber: null, deliveredAt: null };
  return { state: s.status === "DELIVERED" ? ("delivered" as const) : ("in_transit" as const), courier: s.courier, trackingNumber: s.trackingNumber, deliveredAt: s.deliveredAt };
}

const refundedAmountOf = (o: { status: OrderStatus; totalAmount: number; refundAmount: number | null }) => o.refundAmount ?? (o.status === "REFUNDED" ? o.totalAmount : 0);

const rewardReturnedOf = (o: { refunds: { rewardReturn: number }[] }) => o.refunds.reduce((a, r) => a + r.rewardReturn, 0);

export const SELLER_ORDER_PAGE_DEFAULT = 50;
export const SELLER_ORDER_PAGE_MAX = 200;
const ORDER_STATUSES: readonly OrderStatus[] = ["PENDING_PAYMENT", "PAID", "CANCELLED", "REFUNDED"];
const KST_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type SellerOrderListQuery = {
  status?: string[];
  q?: string | null;
  memberId?: string | null;
  shipped?: string | null;
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
  limit?: string | null;
};

// KST 날짜(YYYY-MM-DD)의 0시. 없는 날짜면 null.
export function kstDayStart(s: string): Date | null {
  const m = KST_DATE.exec(s);
  if (!m) return null;
  const d = new Date(`${s}T00:00:00+09:00`);
  if (Number.isNaN(d.getTime())) return null;
  const back = new Date(d.getTime() + 9 * 3600_000);
  if (back.getUTCFullYear() !== Number(m[1]) || back.getUTCMonth() + 1 !== Number(m[2]) || back.getUTCDate() !== Number(m[3])) return null;
  return d;
}

// 커서: 마지막 행의 (주문 시각, id). 같은 시각 주문이 여러 건이어도 id로 끊어 빠지거나 겹치지 않는다.
export function encodeCursor(createdAt: Date, id: string) {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}
export function decodeCursor(s: string): { createdAt: Date; id: string } | null {
  const [at, id] = Buffer.from(s, "base64url").toString().split("|");
  const createdAt = new Date(at ?? "");
  if (!id || !UUID_RE.test(id) || Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 판매자 주문 목록(주문 시각 내림차순, 커서 페이지). 항상 ctx.sellerId 범위만 본다.
// q는 주문번호(숫자 전체 일치)·방송 닉네임(부분 일치)을 찾고, 받는 분 이름은 CUSTOMER_PII_VIEW가 있을 때만 찾는다
// (권한 없는 직원이 검색 결과로 개인정보를 알아내지 못하게). 받는 분 이름으로 찾았으면 customer.pii.view를 남긴다. 잘못된 값이면 { ok: false }.
export async function listSellerOrders(db: PrismaClient, ctx: TenantContext, query: SellerOrderListQuery) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const statuses = query.status ?? [];
  if (statuses.some((s) => !ORDER_STATUSES.includes(s as OrderStatus))) return { ok: false as const };
  const limit = query.limit == null || query.limit === "" ? SELLER_ORDER_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, SELLER_ORDER_PAGE_MAX);
  const from = query.from ? kstDayStart(query.from) : null;
  const toStart = query.to ? kstDayStart(query.to) : null;
  if ((query.from && !from) || (query.to && !toStart)) return { ok: false as const };
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return { ok: false as const };
  if (query.memberId && !UUID_RE.test(query.memberId)) return { ok: false as const };
  // 발송 여부(배송 정보가 있고 발송 전 준비 상태 READY가 아님). 「배송 준비」 = status=PAID&shipped=false. 비어 있으면 거르지 않는다.
  if (query.shipped && query.shipped !== "true" && query.shipped !== "false") return { ok: false as const };

  const searchesPii = q !== "" && canViewCustomerPii(ctx);
  const and: Prisma.OrderWhereInput[] = [{ sellerId: ctx.sellerId, legalHoldAt: null }];
  if (query.memberId) and.push({ buyerMemberId: query.memberId });
  if (query.shipped) and.push(query.shipped === "true" ? { shipment: { is: { status: { not: "READY" } } } } : { OR: [{ shipment: { is: null } }, { shipment: { is: { status: "READY" } } }] });
  if (statuses.length) and.push({ status: { in: statuses as OrderStatus[] } });
  if (from) and.push({ createdAt: { gte: from } });
  if (toStart) and.push({ createdAt: { lt: new Date(toStart.getTime() + 24 * 3600_000) } });
  if (q) {
    const or: Prisma.OrderWhereInput[] = [
      { broadcastNicknameSnapshot: { contains: q, mode: "insensitive" } },
      { buyerMember: { broadcastNickname: { contains: q, mode: "insensitive" } } },
    ];
    if (/^\d{1,9}$/.test(q)) or.push({ orderNo: Number(q) });
    // 사람이 읽는 주문번호(20261005-0004): 그날(KST)에 만든 그 번호의 주문
    const label = parseOrderNoLabel(q);
    if (label) or.push({ orderNo: label.orderNo, createdAt: { gte: label.from, lt: label.to } });
    if (searchesPii) or.push({ shippingAddress: { recipientName: { contains: q, mode: "insensitive" } } });
    and.push({ OR: or });
  }
  if (cursor) and.push({ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] });

  const rows = await db.order.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: take + 1,
    select: {
      id: true,
      orderNo: true,
      status: true,
      createdAt: true,
      paidAt: true,
      totalAmount: true,
      refundAmount: true,
      paymentMethod: true,
      paymentDueAt: true,
      buyerMember: { select: { id: true, broadcastNickname: true } },
      items: itemSummarySelect,
      shipment: { select: { id: true, status: true, courier: true, trackingNumber: true, deliveredAt: true } },
      refunds: { select: { rewardReturn: true } },
      // 처리 대기 중(REQUESTED) 환불 요청 수. 한 번의 조회에서 같이 센다(주문마다 따로 묻지 않음).
      _count: { select: { refundRequests: { where: { status: "REQUESTED" } } } },
    },
  });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  // 받는 분 이름으로 찾았으면 결과(일치 여부)가 개인정보 열람이라 기록을 남긴다. 검색어는 남기지 않고 돌려준 주문 id·건수만 남긴다.
  if (searchesPii) {
    await writeAudit(db, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "customer.pii.view",
      targetType: "OrderSearch",
      reason: "order_list_recipient_search",
      after: { orderIds: page.map((o) => o.id), count: page.length },
    });
  }
  return {
    ok: true as const,
    orders: page.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      orderNoLabel: orderNoLabel(o.createdAt, o.orderNo),
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      buyer: o.buyerMember,
      totalAmount: o.totalAmount,
      // 환불 현황(주문 합계, 현금 환불은 반품 배송비·적립금 반환을 뺀 돌려준 금액). 환불이 없으면 0.
      // 금액이 비어 있는 옛 전액 환불 주문(REFUNDED)은 합계 전부를 돌려준 것으로 본다(통계와 같은 기준).
      // 화면 표기: refundedAmount = 「환불한 금액(현금)」, rewardReturned = 「돌려준 적립금」(환불 때 함께 돌려준 적립금 합계, 현금에는 들어 있지 않음).
      refundedAmount: refundedAmountOf(o),
      rewardReturned: rewardReturnedOf(o),
      refundedQuantity: o.items.reduce((a, i) => a + i.refundedQuantity, 0),
      remainingAmount: Math.max(o.totalAmount - refundedAmountOf(o) - rewardReturnedOf(o), 0),
      // 결제 수단과 입금 기한. 무통장 입금 대기(status=PENDING_PAYMENT, paymentMethod=BANK_TRANSFER) 판별용. 결제 전이면 paymentMethod가 null일 수 있다.
      paymentMethod: o.paymentMethod,
      paymentDueAt: o.paymentDueAt,
      itemSummary: itemSummary(o.items),
      shipped: o.shipment !== null && o.shipment.status !== "READY",
      // 배송 상태: none(발송 정보 없음) · in_transit(배송 중) · delivered(배송 완료). 발송 전 준비 상태(READY)는 none으로 본다.
      shipment: shipmentView(o.shipment),
      refundRequest: { pendingCount: o._count.refundRequests },
      // 환불 API는 결제 완료(PAID) 주문만 받는다. 발송한 주문은 사유 주체(fault)가 필요하다.
      refundable: o.status === "PAID",
    })),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
