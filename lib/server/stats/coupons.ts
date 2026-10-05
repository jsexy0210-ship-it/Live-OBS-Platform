import { Prisma, type PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { ratio, type StatsRange } from "./range";
import { num, statsSnapshot } from "./sql";

// 쿠폰 사용 성과(SALES_VIEW). 조회 기간(주문 시각 KST) 안에 결제된 주문(paidAt 있음 = 결제 완료 + 환불)을 「쿠폰 쓴 주문」과 「안 쓴 주문」으로 나눠 비교한다.
// 쿠폰 쓴 주문 = 쿠폰 사용 기록이 있고 되돌리지 않은(restoredAt 없음) 주문. 통계 요약의 쿠폰 사용 건수·할인액과 같은 기준이다.
// 매출 = 결제액 − 환불액(주문 통계와 같은 순매출 정의). 객단가 = 순매출 / 주문 수(주문이 없으면 null). 쿠폰별은 사용 건수 많은 순 상위 10개.
export const COUPON_ROWS = 10;
type Group = { orders: number; net: bigint; discount: bigint };
type Row = { coupon_id: string; name: string; benefit: string; uses: number; discount: bigint; net: bigint };

const NET = Prisma.sql`o."totalAmount"::bigint - CASE WHEN o.status = 'REFUNDED' THEN coalesce(o."refundAmount", o."totalAmount") ELSE coalesce(o."refundAmount", 0) END`;

const side = (g: Group | undefined) => {
  const orders = num(g?.orders);
  const revenue = num(g?.net);
  return { orders, revenue, averageOrderValue: orders > 0 ? Math.round(revenue / orders) : null };
};

export async function couponStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  return statsSnapshot(db, async (tx) => {
    const [groups, rows] = await Promise.all([
      tx.$queryRaw<(Group & { used: boolean })[]>`
        SELECT (r."orderId" IS NOT NULL AND r."restoredAt" IS NULL) AS used, count(*)::int AS orders, coalesce(sum(${NET}), 0) AS net,
               coalesce(sum(r."discountAmount"::bigint) FILTER (WHERE r."restoredAt" IS NULL), 0) AS discount
        FROM "Order" o LEFT JOIN "CouponRedemption" r ON r."orderId" = o.id AND r."sellerId" = o."sellerId"
        WHERE o."sellerId" = ${ctx.sellerId}::uuid AND o."paidAt" IS NOT NULL AND o."createdAt" >= ${range.start} AND o."createdAt" < ${range.end}
        GROUP BY 1`,
      tx.$queryRaw<Row[]>`
        SELECT c.id AS coupon_id, c.name, c.benefit::text AS benefit, count(*)::int AS uses,
               coalesce(sum(r."discountAmount"::bigint), 0) AS discount, coalesce(sum(${NET}), 0) AS net
        FROM "CouponRedemption" r
        JOIN "Order" o ON o.id = r."orderId" AND o."sellerId" = r."sellerId"
        JOIN "Coupon" c ON c.id = r."couponId" AND c."sellerId" = r."sellerId"
        WHERE r."sellerId" = ${ctx.sellerId}::uuid AND r."restoredAt" IS NULL AND o."paidAt" IS NOT NULL AND o."createdAt" >= ${range.start} AND o."createdAt" < ${range.end}
        GROUP BY c.id, c.name, c.benefit
        ORDER BY uses DESC, discount DESC, c.id
        LIMIT ${COUPON_ROWS}`,
    ]);
    const withCoupon = groups.find((g) => g.used);
    const withoutCoupon = groups.find((g) => !g.used);
    const used = side(withCoupon);
    const unused = side(withoutCoupon);
    return {
      range: { from: range.from, to: range.to },
      withCoupon: { ...used, discount: num(withCoupon?.discount) },
      withoutCoupon: unused,
      useRate: ratio(used.orders, used.orders + unused.orders),
      coupons: rows.map((r) => ({
        couponId: r.coupon_id,
        name: r.name,
        benefit: r.benefit,
        uses: num(r.uses),
        discount: num(r.discount),
        revenue: num(r.net),
        averageOrderValue: r.uses > 0 ? Math.round(num(r.net) / num(r.uses)) : null,
      })),
    };
  });
}
