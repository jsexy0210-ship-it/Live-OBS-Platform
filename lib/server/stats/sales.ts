import { Prisma, type PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import type { StatsRange } from "./range";
import { bucketOf, bucketSeries, num, statsSnapshot, type StatsDb } from "./sql";

// 매출 통계(SALES_VIEW). 주문 통계와 같은 기준: 주문 시각(KST)의 기간에 들어온 주문 중 결제된 적 있는 주문(paidAt 있음).
// - 판매액: 할인 전 금액(품목 정가 × 수량, 정가가 없던 옛 품목은 판매 단가)
// - 할인: 이벤트 할인(정가 − 판매 단가) × 수량
// - 적립금 사용·배송비: 주문에 고정된 값
// - 결제액: 주문 금액(totalAmount = 상품 금액 + 배송비)
// - 환불액: 환불 주문의 실제 환불 금액(없던 옛 주문은 결제액). 순매출 = 결제액 − 환불액
// 결제 수단별은 같은 결제 주문을 수단으로 나눈다(수단 기록이 없는 주문은 OTHER).

export type SalesSummary = {
  gross: number;
  discount: number;
  rewardUsed: number;
  shippingFee: number;
  paid: number;
  refund: number;
  net: number;
  paidOrders: number;
};

type OrderAgg = { paid_orders: number; paid: bigint; reward: bigint; shipping: bigint; refund: bigint };
type ItemAgg = { gross: bigint; discount: bigint };

const ORDER_AGG = Prisma.sql`
  count(*)::int AS paid_orders,
  coalesce(sum("totalAmount"::bigint), 0) AS paid,
  coalesce(sum("rewardUsedAmount"::bigint), 0) AS reward,
  coalesce(sum("shippingFee"::bigint), 0) AS shipping,
  coalesce(sum(coalesce("refundAmount", "totalAmount")::bigint) FILTER (WHERE status = 'REFUNDED'), 0) AS refund`;

const PAID_IN = (sellerId: string, start: Date, end: Date) =>
  Prisma.sql`"sellerId" = ${sellerId}::uuid AND "paidAt" IS NOT NULL AND "createdAt" >= ${start} AND "createdAt" < ${end}`;

async function summary(db: StatsDb, sellerId: string, start: Date, end: Date): Promise<SalesSummary> {
  const [o, i] = await Promise.all([
    db.$queryRaw<OrderAgg[]>`SELECT ${ORDER_AGG} FROM "Order" WHERE ${PAID_IN(sellerId, start, end)}`,
    db.$queryRaw<ItemAgg[]>`
      SELECT
        coalesce(sum(coalesce(i."listUnitPrice", i."unitPrice")::bigint * i.quantity), 0) AS gross,
        coalesce(sum((coalesce(i."listUnitPrice", i."unitPrice") - i."unitPrice")::bigint * i.quantity), 0) AS discount
      FROM "OrderItem" i
      JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
      WHERE i."sellerId" = ${sellerId}::uuid AND o."sellerId" = ${sellerId}::uuid AND o."paidAt" IS NOT NULL
        AND o."createdAt" >= ${start} AND o."createdAt" < ${end}`,
  ]);
  const paid = num(o[0]?.paid);
  const refund = num(o[0]?.refund);
  return {
    gross: num(i[0]?.gross),
    discount: num(i[0]?.discount),
    rewardUsed: num(o[0]?.reward),
    shippingFee: num(o[0]?.shipping),
    paid,
    refund,
    net: paid - refund,
    paidOrders: num(o[0]?.paid_orders),
  };
}

export async function salesStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  const sid = ctx.sellerId;
  return statsSnapshot(db, async (tx) => {
    const [current, previous, byMethod, series] = await Promise.all([
      summary(tx, sid, range.start, range.end),
      summary(tx, sid, range.prev.start, range.prev.end),
      tx.$queryRaw<({ method: string } & OrderAgg)[]>`
        SELECT coalesce("paymentMethod"::text, 'OTHER') AS method, ${ORDER_AGG}
        FROM "Order" WHERE ${PAID_IN(sid, range.start, range.end)}
        GROUP BY 1 ORDER BY 1`,
      tx.$queryRaw<{ bucket: string; paid: bigint | null; refund: bigint | null }[]>`
        WITH s AS (${bucketSeries(range.unit, range.start, range.end)}),
        o AS (
          SELECT ${bucketOf(range.unit, Prisma.sql`"createdAt"`)} AS b, ${ORDER_AGG}
          FROM "Order" WHERE ${PAID_IN(sid, range.start, range.end)}
          GROUP BY 1
        )
        SELECT to_char(s.b, 'YYYY-MM-DD') AS bucket, o.paid, o.refund
        FROM s LEFT JOIN o ON o.b = s.b
        ORDER BY s.b`,
    ]);
    return {
      range: { from: range.from, to: range.to, unit: range.unit, previous: { from: range.prev.from, to: range.prev.to } },
      current,
      previous,
      byMethod: byMethod.map((r) => {
        const paid = num(r.paid);
        const refund = num(r.refund);
        return { method: r.method, paidOrders: num(r.paid_orders), paid, refund, net: paid - refund };
      }),
      series: series.map((r) => {
        const paid = num(r.paid);
        const refund = num(r.refund);
        return { bucket: r.bucket, paid, refund, net: paid - refund };
      }),
    };
  });
}
