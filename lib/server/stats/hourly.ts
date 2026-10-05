import { Prisma, type PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { AGG, toPoint, type AggRow } from "./orders";
import type { StatsRange } from "./range";
import { KST, statsSnapshot } from "./sql";

// 시간대별 주문 통계(SALES_VIEW). 조회 기간 안 주문을 주문 시각의 KST 시(0~23)로 묶는다. 주문·결제·취소·환불 정의는 주문 통계(orders.ts)와 같다.
// 24칸을 항상 모두 주고(주문 없는 시간은 0), peakHour = 주문 수가 가장 많은 시(같으면 이른 시, 주문이 없으면 null).
// 기준은 단위(unit)와 상관없이 기간 전체다.
export async function hourlyStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  return statsSnapshot(db, async (tx) => {
    const rows = await tx.$queryRaw<(AggRow & { hour: number })[]>`
      SELECT extract(hour FROM "createdAt" AT TIME ZONE ${KST})::int AS hour, ${AGG}
      FROM "Order"
      WHERE "sellerId" = ${ctx.sellerId}::uuid AND "createdAt" >= ${range.start} AND "createdAt" < ${range.end}
      GROUP BY 1`;
    const byHour = new Map(rows.map((r) => [r.hour, r]));
    const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, ...toPoint(byHour.get(hour)) }));
    const peak = hours.reduce<(typeof hours)[number] | null>((best, h) => (h.orders > 0 && (!best || h.orders > best.orders) ? h : best), null);
    return {
      range: { from: range.from, to: range.to },
      hours,
      totalOrders: hours.reduce((a, h) => a + h.orders, 0),
      peakHour: peak ? peak.hour : null,
    };
  });
}
