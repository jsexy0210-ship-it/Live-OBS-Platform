import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { canViewCustomerPii, requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { completeDelivery } from "./delivery";
import { orderErrorBody } from "./messages";
import { decodeCursor, encodeCursor, itemSummary, itemSummarySelect, kstDayStart, SELLER_ORDER_PAGE_DEFAULT, SELLER_ORDER_PAGE_MAX } from "./read";
import { shipOrder } from "./ship";
import { SHIPMENT_BATCH_MAX } from "./shipping";
import { orderNoLabel } from "./orderNoLabel";

export { SHIPMENT_BATCH_MAX };

// 파트너스 배송 처리(ORDER_SHIPPING). 상태 전이는 기존 규칙을 그대로 쓴다: 발송·송장 수정은 shipOrder(ship.ts), 배송 완료는 completeDelivery(delivery.ts).
// 여기서는 탭별 목록과, 여러 주문을 한 번에 보내는 묶음 처리(주문마다 따로 처리하고 결과를 주문별로 돌려줌)만 더한다.
// 탭: ready = 지금 발송할 수 있는 주문(shipOrder가 받는 조건: 결제 완료·즉시 발송·재고 차감됨·배송지 있음·아직 발송 전),
//     in_transit = 배송 중(결제 완료 주문), delivered = 배송 완료. 법정 보관으로 분리한 주문(legalHoldAt)은 없는 주문이다.
export const SHIPMENT_TABS = ["ready", "in_transit", "delivered"] as const;
export type ShipmentTab = (typeof SHIPMENT_TABS)[number];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const TAB_WHERE: Record<ShipmentTab, Prisma.OrderWhereInput> = {
  ready: { status: "PAID", fulfillmentType: "IMMEDIATE", stockShortageAt: null, shippingAddress: { isNot: null }, OR: [{ shipment: { is: null } }, { shipment: { is: { status: "READY" } } }] },
  in_transit: { status: "PAID", shipment: { status: "IN_TRANSIT" } },
  delivered: { shipment: { status: "DELIVERED" } },
};

// 기간(from·to)의 기준은 탭마다 다르다(MASTER 결정, 카페24식): 발송 대기 = 주문 시각, 배송 중 = 발송 시각, 배송 완료 = 배송 완료 시각.
// 응답의 dateBasis로 화면이 「주문일·발송일·완료일」 라벨을 고른다.
export const DATE_BASIS = { ready: "orderedAt", in_transit: "shippedAt", delivered: "deliveredAt" } as const satisfies Record<ShipmentTab, string>;
const dateWhere = (tab: ShipmentTab, range: Prisma.DateTimeFilter): Prisma.OrderWhereInput =>
  tab === "ready" ? { createdAt: range } : { shipment: { is: tab === "in_transit" ? { shippedAt: range } : { deliveredAt: range } } };
// 정렬도 같은 기준 시각 내림차순(같으면 주문 id 내림차순). 커서는 (기준 시각, 주문 id).
const sortAt = (tab: ShipmentTab, o: { createdAt: Date; shipment: { shippedAt: Date; deliveredAt: Date | null } | null }) =>
  tab === "ready" ? o.createdAt : tab === "in_transit" ? o.shipment!.shippedAt : o.shipment!.deliveredAt!;
const ORDER_BY: Record<ShipmentTab, Prisma.OrderOrderByWithRelationInput[]> = {
  ready: [{ createdAt: "desc" }, { id: "desc" }],
  in_transit: [{ shipment: { shippedAt: "desc" } }, { id: "desc" }],
  delivered: [{ shipment: { deliveredAt: "desc" } }, { id: "desc" }],
};
const afterCursor = (tab: ShipmentTab, c: { createdAt: Date; id: string }): Prisma.OrderWhereInput => {
  const before = (at: Prisma.DateTimeFilter) => dateWhere(tab, at);
  return { OR: [before({ lt: c.createdAt }), { AND: [before({ equals: c.createdAt }), { id: { lt: c.id } }] }] };
};
// 기간은 최대 366일(통계와 같음). 시작일이 종료일보다 늦으면 잘못된 요청.
export const SHIPMENT_RANGE_MAX_DAYS = 366;

export type ShipmentListQuery = { tab?: string | null; q?: string | null; from?: string | null; to?: string | null; cursor?: string | null; limit?: string | null };

// 탭별 목록(탭의 기준 시각 내림차순: 발송 대기 = 주문 시각, 배송 중 = 발송 시각, 배송 완료 = 배송 완료 시각, (기준 시각, id) 커서). q: 주문번호(숫자 전체 일치)·방송 닉네임·송장번호, 받는 분 이름은 개인정보 권한이 있을 때만.
// 받는 분 이름·연락처·주소는 CUSTOMER_PII_VIEW가 있을 때만 넣고, 넣었으면 customer.pii.view(주문 id·건수만)를 남긴다. 잘못된 값이면 { ok: false }.
export async function listShipments(db: PrismaClient, ctx: TenantContext, query: ShipmentListQuery) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const tab = (query.tab || "ready") as ShipmentTab;
  if (!SHIPMENT_TABS.includes(tab)) return { ok: false as const };
  const limit = query.limit == null || query.limit === "" ? SELLER_ORDER_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, SELLER_ORDER_PAGE_MAX);
  const from = query.from ? kstDayStart(query.from) : null;
  const toStart = query.to ? kstDayStart(query.to) : null;
  if ((query.from && !from) || (query.to && !toStart)) return { ok: false as const };
  if (from && toStart && (toStart < from || toStart.getTime() - from.getTime() >= SHIPMENT_RANGE_MAX_DAYS * 24 * 3600_000)) return { ok: false as const };
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return { ok: false as const };

  const pii = canViewCustomerPii(ctx);
  const searchesPii = q !== "" && pii;
  const and: Prisma.OrderWhereInput[] = [{ sellerId: ctx.sellerId, legalHoldAt: null }, TAB_WHERE[tab]];
  if (from || toStart) and.push(dateWhere(tab, { ...(from ? { gte: from } : {}), ...(toStart ? { lt: new Date(toStart.getTime() + 24 * 3600_000) } : {}) }));
  if (q) {
    const or: Prisma.OrderWhereInput[] = [
      { broadcastNicknameSnapshot: { contains: q, mode: "insensitive" } },
      { buyerMember: { broadcastNickname: { contains: q, mode: "insensitive" } } },
      { shipment: { trackingNumber: q.replace(/[\s-]/g, "") } },
    ];
    if (/^\d{1,9}$/.test(q)) or.push({ orderNo: Number(q) });
    if (searchesPii) or.push({ shippingAddress: { recipientName: { contains: q, mode: "insensitive" } } });
    and.push({ OR: or });
  }
  if (cursor) and.push(afterCursor(tab, cursor));

  const rows = await db.order.findMany({
    where: { AND: and },
    orderBy: ORDER_BY[tab],
    take: take + 1,
    select: {
      id: true,
      orderNo: true,
      status: true,
      createdAt: true,
      paidAt: true,
      buyerMember: { select: { id: true, broadcastNickname: true } },
      items: itemSummarySelect,
      shipment: { select: { courier: true, trackingNumber: true, status: true, shippedAt: true, deliveredAt: true } },
      shippingAddress: { select: { recipientName: true, phone: true, zipCode: true, address1: true, address2: true, memo: true, isRemote: true } },
    },
  });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  // 받는 분 정보를 내보냈거나 받는 분 이름으로 찾았으면 기록한다. 이름으로 찾았으면 결과가 0건이어도 남긴다(일치 여부도 개인정보 확인, #215 Codex).
  if (searchesPii || (pii && page.length > 0)) {
    await writeAudit(db, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "customer.pii.view",
      targetType: "ShipmentList",
      reason: searchesPii ? "shipment_list_search" : "shipment_list",
      after: { orderIds: page.map((o) => o.id), count: page.length },
    });
  }
  return {
    ok: true as const,
    dateBasis: DATE_BASIS[tab],
    shipments: page.map((o) => ({
      orderId: o.id,
      orderNo: o.orderNo,
      orderNoLabel: orderNoLabel(o.createdAt, o.orderNo),
      status: o.status,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      buyer: o.buyerMember,
      // 부분 환불로 다 돌려준 품목은 보낼 것이 없어 요약에서 뺀다(orders/read.ts itemSummary)
      itemSummary: itemSummary(o.items),
      shipment: o.shipment,
      // 배송지도 개인정보라 권한이 없으면 도서산간 여부만 남긴다(orders/read.ts getOrder와 같은 기준)
      shippingAddress: o.shippingAddress ? (pii ? o.shippingAddress : { isRemote: o.shippingAddress.isRemote }) : null,
    })),
    nextCursor: rows.length > take && last ? encodeCursor(sortAt(tab, last), last.id) : null,
  };
}

// 묶음 요청 본문 검사: 1~100건, 주문 id 형식, 같은 주문 중복 없음.
function batchIds(ids: unknown[]): string[] | null {
  if (ids.length < 1 || ids.length > SHIPMENT_BATCH_MAX) return null;
  if (ids.some((id) => typeof id !== "string" || !UUID_RE.test(id))) return null;
  const list = ids as string[];
  return new Set(list.map((id) => id.toLowerCase())).size === list.length ? list : null;
}

type BatchResult = { orderId: string; ok: true; [k: string]: unknown } | { orderId: string; ok: false; error: string; message?: string };

// 송장 입력·일괄 입력. 본문 items: [{ orderId, courier, trackingNumber }]. 주문마다 shipOrder로 따로 처리한다(한 건이 실패해도 나머지는 처리).
// 결과 mode: 처음 발송(shipped)·이미 배송 중인 송장 바꿈(updated, previous = 바꾸기 전 택배사·송장번호).
export async function shipOrders(db: PrismaClient, ctx: TenantContext, items: unknown): Promise<{ ok: true; results: BatchResult[] } | { ok: false }> {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!Array.isArray(items) || items.some((i) => typeof i !== "object" || i === null)) return { ok: false };
  const rows = items as { orderId?: unknown; courier?: unknown; trackingNumber?: unknown }[];
  if (!batchIds(rows.map((i) => i.orderId))) return { ok: false };
  const results: BatchResult[] = [];
  for (const i of rows) {
    const orderId = i.orderId as string;
    const r = await shipOrder(db, ctx, orderId, { courier: i.courier, trackingNumber: i.trackingNumber });
    if (r.ok) results.push({ orderId, ok: true, mode: r.mode, previous: r.previous, shipment: r.shipment });
    else results.push(r.reason === "not_found" ? { orderId, ok: false, error: "not_found" } : { orderId, ok: false, ...orderErrorBody(r.reason, "formal") });
  }
  return { ok: true, results };
}

// 배송 완료 처리(한 건·여러 건). 본문 orderIds. 주문마다 completeDelivery로 따로 처리한다.
export async function deliverOrders(db: PrismaClient, ctx: TenantContext, orderIds: unknown): Promise<{ ok: true; results: BatchResult[] } | { ok: false }> {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!Array.isArray(orderIds)) return { ok: false };
  const ids = batchIds(orderIds);
  if (!ids) return { ok: false };
  const results: BatchResult[] = [];
  for (const orderId of ids) {
    const r = await completeDelivery(db, ctx, orderId);
    if (r.ok) results.push({ orderId, ok: true, deliveredAt: r.deliveredAt, rewardEarned: r.rewardEarned });
    else results.push(r.reason === "not_found" ? { orderId, ok: false, error: "not_found" } : { orderId, ok: false, ...orderErrorBody(r.reason, "formal") });
  }
  return { ok: true, results };
}
