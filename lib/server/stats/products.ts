import type { PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import type { StatsRange } from "./range";
import { num, statsSnapshot, type StatsDb } from "./sql";

// 상품 통계(SALES_VIEW). 주문 시각(KST) 기간의 결제 완료 주문(PAID, 환불된 주문은 뺌)에 담긴 품목으로 센다.
// - 판매 수량·매출(판매 단가 × 수량)은 상품별. 주문 때 상품명 스냅숏이 아니라 지금 상품 이름을 보여 준다(지운 상품은 표시)
// - 안 팔린 상품: 지우지 않았고 임시 저장이 아닌 상품 중 그 기간 판매가 0인 상품
export const PRODUCT_TOP_LIMIT = 50;
export const UNSOLD_LIMIT = 50;

type Row = { product_id: string; name: string; deleted: boolean; quantity: bigint; revenue: bigint; orders: number };

export async function productStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  return statsSnapshot(db, (tx) => productStatsIn(tx, ctx, range));
}

// 같은 스냅숏 안에서 다른 집계와 함께 부를 때(통계 요약). 권한 검사는 부르는 쪽이 한다.
export async function productStatsIn(tx: StatsDb, ctx: TenantContext, range: StatsRange) {
  const sid = ctx.sellerId;
  const sold = (start: Date, end: Date) => tx.$queryRaw<Row[]>`
    SELECT p.id AS product_id, p.name, p."deletedAt" IS NOT NULL AS deleted,
      sum(i.quantity)::bigint AS quantity,
      sum(i."unitPrice"::bigint * i.quantity) AS revenue,
      count(DISTINCT o.id)::int AS orders
    FROM "OrderItem" i
    JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
    JOIN "Product" p ON p.id = i."productId" AND p."sellerId" = i."sellerId"
    WHERE i."sellerId" = ${sid}::uuid AND o."sellerId" = ${sid}::uuid AND o.status = 'PAID'
      AND o."createdAt" >= ${start} AND o."createdAt" < ${end}
    GROUP BY p.id
    ORDER BY revenue DESC, quantity DESC, p.id`;
  const [current, previous, unsold, unsoldCount] = await Promise.all([
    sold(range.start, range.end),
    tx.$queryRaw<{ quantity: bigint; revenue: bigint; products: number }[]>`
      SELECT coalesce(sum(i.quantity), 0)::bigint AS quantity, coalesce(sum(i."unitPrice"::bigint * i.quantity), 0) AS revenue,
        count(DISTINCT i."productId")::int AS products
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
      WHERE i."sellerId" = ${sid}::uuid AND o."sellerId" = ${sid}::uuid AND o.status = 'PAID'
        AND o."createdAt" >= ${range.prev.start} AND o."createdAt" < ${range.prev.end}`,
    tx.$queryRaw<{ id: string; name: string; status: string; created_at: Date }[]>`
      SELECT p.id, p.name, p.status::text AS status, p."createdAt" AS created_at FROM "Product" p
      WHERE p."sellerId" = ${sid}::uuid AND p."deletedAt" IS NULL AND p.status <> 'DRAFT'
        AND NOT EXISTS (
          SELECT 1 FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
          WHERE i."sellerId" = ${sid}::uuid AND i."productId" = p.id AND o.status = 'PAID'
            AND o."createdAt" >= ${range.start} AND o."createdAt" < ${range.end})
      ORDER BY p."createdAt", p.id
      LIMIT ${UNSOLD_LIMIT}`,
    tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Product" p
      WHERE p."sellerId" = ${sid}::uuid AND p."deletedAt" IS NULL AND p.status <> 'DRAFT'
        AND NOT EXISTS (
          SELECT 1 FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
          WHERE i."sellerId" = ${sid}::uuid AND i."productId" = p.id AND o.status = 'PAID'
            AND o."createdAt" >= ${range.start} AND o."createdAt" < ${range.end})`,
  ]);
  const rows = current.map((r) => ({ productId: r.product_id, name: r.name, deleted: r.deleted, quantity: num(r.quantity), revenue: num(r.revenue), orders: num(r.orders) }));
  return {
    range: { from: range.from, to: range.to, unit: range.unit, previous: { from: range.prev.from, to: range.prev.to } },
    current: { quantity: rows.reduce((s, r) => s + r.quantity, 0), revenue: rows.reduce((s, r) => s + r.revenue, 0), products: rows.length },
    previous: { quantity: num(previous[0]?.quantity), revenue: num(previous[0]?.revenue), products: num(previous[0]?.products) },
    top: rows.slice(0, PRODUCT_TOP_LIMIT),
    // 수량 기준 상위(매출 상위를 다시 정렬하지 않고, 팔린 상품 전체에서 고른다)
    topByQuantity: [...rows].sort((x, y) => y.quantity - x.quantity || y.revenue - x.revenue || (x.productId < y.productId ? -1 : 1)).slice(0, PRODUCT_TOP_LIMIT),
    unsold: unsold.map((p) => ({ productId: p.id, name: p.name, status: p.status })),
    unsoldCount: num(unsoldCount[0]?.n),
  };
}
