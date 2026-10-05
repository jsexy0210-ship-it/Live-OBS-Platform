import type { OrderStatus, Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { canViewCustomerPii, requireSellerRead, type TenantContext } from "../tenant/context";

// 판매자 범위 조회의 기준 예시. where에는 항상 ctx.sellerId가 들어가고, 다른 판매자 주문은 없음(404)으로 처리한다.
// 구매자 이름·연락처(·주소)는 CUSTOMER_PII_VIEW가 있을 때만 응답에 넣고, 넣었으면 열람 기록을 남긴다
// (화면에서 가리는 것으로는 부족하다, 대표님 결정 2026-10-02).
// 탈퇴 회원의 법정 보관으로 분리한 주문(legalHoldAt, buyers/legalHold.ts)은 일반 조회(상세·목록·검색)에서 없는 주문으로 다룬다.
export async function getOrder(db: PrismaClient, ctx: TenantContext, orderId: string) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const order = await db.order.findFirst({
    where: { id: orderId, sellerId: ctx.sellerId, legalHoldAt: null },
    include: {
      items: true,
      couponRedemption: { select: { benefit: true, discountAmount: true, restoredAt: true, coupon: { select: { id: true, name: true } } } },
      shipment: { select: { courier: true, trackingNumber: true, status: true, shippedAt: true, deliveredAt: true } },
      shippingAddress: { select: { recipientName: true, phone: true, zipCode: true, address1: true, address2: true, memo: true, isRemote: true } },
      buyerMember: { select: { id: true, broadcastNickname: true, name: true, phone: true } },
    },
  });
  if (!order) throw notFound();

  const { buyerMember, shippingAddress, ...orderRest } = order;
  // 품목마다 보낼 수량(수량 − 부분 환불한 수량). 화면은 refundedQuantity로 「부분 환불 n개」를 보여 준다.
  const rest = { ...orderRest, items: order.items.map((i) => ({ ...i, shipQuantity: i.quantity - i.refundedQuantity })) };
  if (!canViewCustomerPii(ctx)) {
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

export const SELLER_ORDER_PAGE_DEFAULT = 50;
export const SELLER_ORDER_PAGE_MAX = 200;
const ORDER_STATUSES: readonly OrderStatus[] = ["PENDING_PAYMENT", "PAID", "CANCELLED", "REFUNDED"];
const KST_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type SellerOrderListQuery = {
  status?: string[];
  q?: string | null;
  memberId?: string | null;
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

  const searchesPii = q !== "" && canViewCustomerPii(ctx);
  const and: Prisma.OrderWhereInput[] = [{ sellerId: ctx.sellerId, legalHoldAt: null }];
  if (query.memberId) and.push({ buyerMemberId: query.memberId });
  if (statuses.length) and.push({ status: { in: statuses as OrderStatus[] } });
  if (from) and.push({ createdAt: { gte: from } });
  if (toStart) and.push({ createdAt: { lt: new Date(toStart.getTime() + 24 * 3600_000) } });
  if (q) {
    const or: Prisma.OrderWhereInput[] = [
      { broadcastNicknameSnapshot: { contains: q, mode: "insensitive" } },
      { buyerMember: { broadcastNickname: { contains: q, mode: "insensitive" } } },
    ];
    if (/^\d{1,9}$/.test(q)) or.push({ orderNo: Number(q) });
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
      buyerMember: { select: { id: true, broadcastNickname: true } },
      items: itemSummarySelect,
      shipment: { select: { id: true } },
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
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      buyer: o.buyerMember,
      totalAmount: o.totalAmount,
      itemSummary: itemSummary(o.items),
      shipped: o.shipment !== null,
      // 환불 API는 결제 완료(PAID) 주문만 받는다. 발송한 주문은 사유 주체(fault)가 필요하다.
      refundable: o.status === "PAID",
    })),
    nextCursor: rows.length > take && last ? encodeCursor(last.createdAt, last.id) : null,
  };
}
