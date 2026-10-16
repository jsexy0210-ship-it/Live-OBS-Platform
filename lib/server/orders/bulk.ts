import type { ActorType, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow } from "../billing/subscription";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { queueStateOf, queueStateWhere, refundRequestedWhere, trackingMissingWhere } from "./read";
import { SHIPMENT_BATCH_MAX } from "./shipping";

// 주문 목록(SA-021)의 칩 건수와 선택 일괄(ORDER_SHIPPING). 항상 ctx.sellerId 범위이고 법정 보관 주문(legalHoldAt)은 없는 주문이다.
// - 칩 건수(countSellerOrders): 목록 필터와 같은 조건으로 센다(read.ts의 queueStateWhere·trackingMissingWhere·refundRequestedWhere).
// - 선택 일괄 「배송 준비로 변경」(prepareShipping): 개봉 완료(큐 항목이 모두 끝남) 상태의 결제 완료 주문만 shippingPreparedAt을 찍고 구매자 안내 기록(OrderNotification SHIPPING_PREPARED)을 남긴다.
//   표식일 뿐이라 발송 가능 조건(shipments.ts 발송 대기)은 바꾸지 않는다. 주문마다 따로 처리해 결과를 돌려준다.
// - 선택 일괄 「송장 일괄 입력」은 송장 발급(invoices/service.ts issueInvoices, 모의 발급)을 그대로 쓴다.
const KST_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 오늘(KST 0시~24시)의 UTC 구간
export function kstTodayRange(now: Date): { from: Date; to: Date } {
  const k = new Date(now.getTime() + KST_MS);
  const from = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KST_MS);
  return { from, to: new Date(from.getTime() + DAY_MS) };
}

// 칩 건수: total(전체)·today(오늘 접수)·todaySales(오늘 결제된 주문의 금액 합계 − 환불 금액)·unpaid(입금 전)·trackingMissing(송장 미입력: 결제 완료·발송 전)·
// queueWaiting·queueOpening·queueDone(결제 완료 주문의 방송 큐 상태별)·refundRequested(처리 대기 환불 요청이 있는 주문)·cancelled·refunded.
export async function countSellerOrders(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "ORDER_SHIPPING");
  const now = await dbNow(db);
  const today = kstTodayRange(now);
  const base = { sellerId: ctx.sellerId, legalHoldAt: null } as const;
  const paid = { ...base, status: "PAID" as const };
  const [total, todayCount, sales, unpaid, trackingMissing, queueWaiting, queueOpening, queueDone, refundRequested, cancelled, refunded] = await Promise.all([
    db.order.count({ where: base }),
    db.order.count({ where: { ...base, createdAt: { gte: today.from, lt: today.to } } }),
    db.order.aggregate({ where: { ...base, paidAt: { gte: today.from, lt: today.to } }, _sum: { totalAmount: true, refundAmount: true } }),
    db.order.count({ where: { ...base, status: "PENDING_PAYMENT" } }),
    db.order.count({ where: { AND: [base, trackingMissingWhere] } }),
    db.order.count({ where: { AND: [paid, queueStateWhere("waiting")] } }),
    db.order.count({ where: { AND: [paid, queueStateWhere("opening")] } }),
    db.order.count({ where: { AND: [paid, queueStateWhere("done")] } }),
    db.order.count({ where: { AND: [base, refundRequestedWhere] } }),
    db.order.count({ where: { ...base, status: "CANCELLED" } }),
    db.order.count({ where: { ...base, status: "REFUNDED" } }),
  ]);
  return {
    total,
    today: todayCount,
    todaySales: Math.max((sales._sum.totalAmount ?? 0) - (sales._sum.refundAmount ?? 0), 0),
    unpaid,
    trackingMissing,
    queueWaiting,
    queueOpening,
    queueDone,
    refundRequested,
    cancelled,
    refunded,
  };
}

export type PrepareFailure = "not_found" | "not_paid" | "not_ready" | "already_shipped" | "already_prepared" | "not_opened";
export type PrepareResult = { orderId: string; ok: true } | { orderId: string; ok: false; reason: PrepareFailure };

// 선택 주문을 배송 준비로 변경(1~100건, 같은 주문 중복 없음). 잘못된 본문이면 { ok: false }.
// 건너뜀 이유: not_found · not_paid(결제 완료 아님) · not_ready(즉시 발송이 아니거나 재고 부족) · already_shipped(이미 발송) · already_prepared(이미 변경함) · not_opened(개봉 완료 아님).
export async function prepareShipping(db: PrismaClient, ctx: TenantContext, orderIds: unknown) {
  requireSellerPermission(ctx, "ORDER_SHIPPING");
  if (!Array.isArray(orderIds) || orderIds.length < 1 || orderIds.length > SHIPMENT_BATCH_MAX || orderIds.some((i) => typeof i !== "string" || !UUID_RE.test(i))) return { ok: false as const };
  const ids = (orderIds as string[]).map((i) => i.toLowerCase());
  if (new Set(ids).size !== ids.length) return { ok: false as const };
  const results: PrepareResult[] = [];
  for (const orderId of ids) {
    results.push(
      await db.$transaction(async (tx): Promise<PrepareResult> => {
        const [locked] = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "Order" WHERE "id" = ${orderId}::uuid AND "sellerId" = ${ctx.sellerId}::uuid AND "legalHoldAt" IS NULL FOR UPDATE`;
        if (!locked) return { orderId, ok: false, reason: "not_found" };
        const o = await tx.order.findUniqueOrThrow({
          where: { id: orderId },
          select: { status: true, fulfillmentType: true, stockShortageAt: true, shippingPreparedAt: true, shipment: { select: { status: true } }, queueItems: { select: { status: true } } },
        });
        if (o.status !== "PAID") return { orderId, ok: false, reason: "not_paid" };
        if (o.fulfillmentType !== "IMMEDIATE" || o.stockShortageAt) return { orderId, ok: false, reason: "not_ready" };
        if (o.shipment && o.shipment.status !== "READY") return { orderId, ok: false, reason: "already_shipped" };
        if (o.shippingPreparedAt) return { orderId, ok: false, reason: "already_prepared" };
        if (queueStateOf(o.queueItems) !== "done") return { orderId, ok: false, reason: "not_opened" };
        const now = await dbNow(tx);
        await tx.order.update({ where: { id: orderId }, data: { shippingPreparedAt: now } });
        await tx.orderNotification.createMany({ data: [{ sellerId: ctx.sellerId, orderId, kind: "SHIPPING_PREPARED", claimedAt: now }], skipDuplicates: true });
        await writeAudit(tx, { actorType: ctx.actorType as ActorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "order.shipping_prepare", targetType: "Order", targetId: orderId });
        return { orderId, ok: true };
      }),
    );
  }
  return { ok: true as const, results, prepared: results.filter((r) => r.ok).length };
}
