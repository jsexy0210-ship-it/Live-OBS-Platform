import { Prisma, type PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { ratio, type StatsRange } from "./range";
import { bucketOf, bucketSeries, num } from "./sql";

// 주문 통계(SALES_VIEW). 기준은 주문 시각(createdAt, KST)이다. 그 기간에 들어온 주문을 지금 상태로 센다.
// - 주문 수: 모든 상태(결제 대기·결제 완료·취소·환불)
// - 결제 주문·결제액: 결제된 적 있는 주문(paidAt 있음 = 결제 완료 + 환불). 객단가 = 결제액 / 결제 주문
// - 취소: 결제 전 취소(CANCELLED, 판매자 취소·입금 기한 초과·탈퇴). 취소율 = 취소 / 주문 수
// - 환불: 결제 뒤 환불(REFUNDED). 환불율 = 환불 / 결제 주문. 환불액은 실제 돌려준 금액(refundAmount, 이 값이 없던 옛 주문은 결제액)
// - 순매출 = 결제액 − 환불액
// 테스트 모드는 서버 단위 설정(OBS_TEST_MODE)이고 주문에 표시가 없다. 테스트 서버 DB의 주문은 모두 시험 주문이라 그대로 센다.
// 탈퇴 회원의 법정 보관 분리 주문(legalHoldAt)도 실제 판매라 합계에 넣는다(개인정보는 내보내지 않음).

export type OrderSummary = {
  orders: number;
  paidOrders: number;
  revenue: number;
  averageOrderValue: number | null;
  cancelled: number;
  cancelRate: number | null;
  refunded: number;
  refundRate: number | null;
  refundAmount: number;
  netRevenue: number;
};

export type OrderPoint = { bucket: string } & Omit<OrderSummary, "averageOrderValue" | "cancelRate" | "refundRate">;

const AGG = Prisma.sql`
  count(*)::int AS orders,
  count(*) FILTER (WHERE "paidAt" IS NOT NULL)::int AS paid,
  coalesce(sum("totalAmount"::bigint) FILTER (WHERE "paidAt" IS NOT NULL), 0) AS revenue,
  count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
  count(*) FILTER (WHERE status = 'REFUNDED')::int AS refunded,
  coalesce(sum(coalesce("refundAmount", "totalAmount")::bigint) FILTER (WHERE status = 'REFUNDED'), 0) AS refund_amount`;

type AggRow = { orders: number; paid: number; revenue: bigint; cancelled: number; refunded: number; refund_amount: bigint };

function toPoint(r: AggRow | undefined) {
  const revenue = num(r?.revenue);
  const refundAmount = num(r?.refund_amount);
  return {
    orders: num(r?.orders),
    paidOrders: num(r?.paid),
    revenue,
    cancelled: num(r?.cancelled),
    refunded: num(r?.refunded),
    refundAmount,
    netRevenue: revenue - refundAmount,
  };
}

function toSummary(r: AggRow | undefined): OrderSummary {
  const p = toPoint(r);
  return {
    ...p,
    averageOrderValue: p.paidOrders > 0 ? Math.round(p.revenue / p.paidOrders) : null,
    cancelRate: ratio(p.cancelled, p.orders),
    refundRate: ratio(p.refunded, p.paidOrders),
  };
}

async function summary(db: PrismaClient, sellerId: string, start: Date, end: Date) {
  const rows = await db.$queryRaw<AggRow[]>`
    SELECT ${AGG} FROM "Order"
    WHERE "sellerId" = ${sellerId}::uuid AND "createdAt" >= ${start} AND "createdAt" < ${end}`;
  return toSummary(rows[0]);
}

export async function orderStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  const [current, previous, series] = await Promise.all([
    summary(db, ctx.sellerId, range.start, range.end),
    summary(db, ctx.sellerId, range.prev.start, range.prev.end),
    db.$queryRaw<(AggRow & { bucket: string })[]>`
      WITH s AS (${bucketSeries(range.unit, range.start, range.end)}),
      o AS (
        SELECT ${bucketOf(range.unit, Prisma.sql`"createdAt"`)} AS b, ${AGG}
        FROM "Order"
        WHERE "sellerId" = ${ctx.sellerId}::uuid AND "createdAt" >= ${range.start} AND "createdAt" < ${range.end}
        GROUP BY 1
      )
      SELECT to_char(s.b, 'YYYY-MM-DD') AS bucket, o.orders, o.paid, o.revenue, o.cancelled, o.refunded, o.refund_amount
      FROM s LEFT JOIN o ON o.b = s.b
      ORDER BY s.b`,
  ]);
  return {
    range: { from: range.from, to: range.to, unit: range.unit, previous: { from: range.prev.from, to: range.prev.to } },
    current,
    previous,
    series: series.map((r): OrderPoint => ({ bucket: r.bucket, ...toPoint(r) })),
  };
}
