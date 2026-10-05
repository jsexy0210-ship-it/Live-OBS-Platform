import { Prisma, type PrismaClient } from "@prisma/client";
import { adminCan } from "../authz/permissions";
import { forbidden } from "../authz/errors";
import type { AdminSessionContext } from "../auth/session";
import { AGG, toPoint, toSummary, type AggRow, type OrderPoint } from "./orders";
import type { StatsRange } from "./range";
import { bucketOf, bucketSeries, statsSnapshot } from "./sql";

// 마스터 관리자 플랫폼 통계(조회 전용, platform.read). 파트너스·구매자 개인정보 없이 숫자만 준다.
// ① 플랫폼 전체 일별 주문·결제: 주문·결제액 기준은 파트너스 주문 통계(orders.ts)와 같다(같은 집계 조각을 쓴다).
//    전기(바로 앞 같은 일수) 합계를 함께 줘 증감을 비교한다.
export async function platformOrderStats(db: PrismaClient, admin: AdminSessionContext, range: StatsRange) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  return statsSnapshot(db, async (tx) => {
    const sum = async (start: Date, end: Date) =>
      toSummary(
        (await tx.$queryRaw<AggRow[]>`SELECT ${AGG} FROM "Order" WHERE "createdAt" >= ${start} AND "createdAt" < ${end}`)[0],
      );
    const [current, previous, series] = await Promise.all([
      sum(range.start, range.end),
      sum(range.prev.start, range.prev.end),
      tx.$queryRaw<(AggRow & { bucket: string })[]>`
        WITH s AS (${bucketSeries(range.unit, range.start, range.end)}),
        o AS (
          SELECT ${bucketOf(range.unit, Prisma.sql`"createdAt"`)} AS b, ${AGG}
          FROM "Order"
          WHERE "createdAt" >= ${range.start} AND "createdAt" < ${range.end}
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
  });
}
