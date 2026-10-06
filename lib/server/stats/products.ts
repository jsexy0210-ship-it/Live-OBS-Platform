import type { PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import type { StatsRange } from "./range";
import { num, statsSnapshot, type StatsDb } from "./sql";

// 상품 통계(SALES_VIEW). 주문 시각(KST) 기간의 결제 완료 주문(PAID, 환불된 주문은 뺌)에 담긴 품목으로 센다. 부분 환불한 수량은 빼고, 다 돌려준 품목은 판매 없음으로 본다.
// - 판매 수량·매출(판매 단가 × 수량)은 상품별. 주문 때 상품명 스냅숏이 아니라 지금 상품 이름을 보여 준다(지운 상품은 표시)
// - 안 팔린 상품: 지우지 않았고 임시 저장이 아닌 상품 중 그 기간 판매가 0인 상품
// - SA-056-P(상품 통계 화면, 2026-10-06): 요약(등록 상품 수·상위 3개 비중·품절로 놓친 추정), 상품 열(카테고리·매출 비중·재고·바로 앞 기간),
//   카테고리별 매출, 안 팔린 상품 열(등록일·재고·마지막 판매)을 함께 준다.
//   · 카테고리: 상품이 여러 카테고리에 있으면 먼저 넣은 카테고리 하나로만 센다(합계가 전체와 같고 비율 합이 100%). 없으면 「미분류」(categoryId null).
//   · 재고: 지우지 않은 옵션 재고 합. 마지막 판매: 이 상품이 든 결제 완료 주문(환불로 다 돌려준 품목 제외)의 가장 늦은 주문 시각(기간과 상관없이 전체).
//   · 품절로 놓친 추정(missedBySoldOut): 그 기간에 들어온 재입고 알림 신청 수(품절 상품을 사려던 구매자가 남긴 신청).
export const PRODUCT_TOP_LIMIT = 50;
export const UNSOLD_LIMIT = 50;

const TOP_SHARE_COUNT = 3;
const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

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
      sum(i.quantity - i."refundedQuantity")::bigint AS quantity,
      sum(i."unitPrice"::bigint * (i.quantity - i."refundedQuantity")) AS revenue,
      count(DISTINCT o.id)::int AS orders
    FROM "OrderItem" i
    JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
    JOIN "Product" p ON p.id = i."productId" AND p."sellerId" = i."sellerId"
    WHERE i."sellerId" = ${sid}::uuid AND o."sellerId" = ${sid}::uuid AND o.status = 'PAID' AND i.quantity > i."refundedQuantity"
      AND o."createdAt" >= ${start} AND o."createdAt" < ${end}
    GROUP BY p.id
    ORDER BY revenue DESC, quantity DESC, p.id`;
  const [current, previous, unsold, unsoldCount, prevRows, catalog, registered, missed] = await Promise.all([
    sold(range.start, range.end),
    tx.$queryRaw<{ quantity: bigint; revenue: bigint; products: number }[]>`
      SELECT coalesce(sum(i.quantity - i."refundedQuantity"), 0)::bigint AS quantity, coalesce(sum(i."unitPrice"::bigint * (i.quantity - i."refundedQuantity")), 0) AS revenue,
        count(DISTINCT i."productId")::int AS products
      FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
      WHERE i."sellerId" = ${sid}::uuid AND o."sellerId" = ${sid}::uuid AND o.status = 'PAID' AND i.quantity > i."refundedQuantity"
        AND o."createdAt" >= ${range.prev.start} AND o."createdAt" < ${range.prev.end}`,
    tx.$queryRaw<{ id: string; name: string; status: string; created_at: Date }[]>`
      SELECT p.id, p.name, p.status::text AS status, p."createdAt" AS created_at FROM "Product" p
      WHERE p."sellerId" = ${sid}::uuid AND p."deletedAt" IS NULL AND p.status <> 'DRAFT'
        AND NOT EXISTS (
          SELECT 1 FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
          WHERE i."sellerId" = ${sid}::uuid AND i."productId" = p.id AND o.status = 'PAID' AND i.quantity > i."refundedQuantity"
            AND o."createdAt" >= ${range.start} AND o."createdAt" < ${range.end})
      ORDER BY p."createdAt", p.id
      LIMIT ${UNSOLD_LIMIT}`,
    tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Product" p
      WHERE p."sellerId" = ${sid}::uuid AND p."deletedAt" IS NULL AND p.status <> 'DRAFT'
        AND NOT EXISTS (
          SELECT 1 FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
          WHERE i."sellerId" = ${sid}::uuid AND i."productId" = p.id AND o.status = 'PAID' AND i.quantity > i."refundedQuantity"
            AND o."createdAt" >= ${range.start} AND o."createdAt" < ${range.end})`,
    sold(range.prev.start, range.prev.end),
    // 상품별 카테고리(먼저 넣은 하나)·재고. 지운 상품도 포함(판매 이력에 나오므로)
    tx.$queryRaw<{ id: string; category_id: string | null; category_name: string | null; stock: bigint; draft: boolean; deleted: boolean }[]>`
      SELECT p.id, c.id AS category_id, c.name AS category_name, p.status = 'DRAFT' AS draft, p."deletedAt" IS NOT NULL AS deleted,
        coalesce((SELECT sum(o.stock) FROM "ProductOption" o WHERE o."productId" = p.id AND o."sellerId" = p."sellerId" AND o."deletedAt" IS NULL), 0)::bigint AS stock
      FROM "Product" p
      LEFT JOIN LATERAL (
        SELECT sc.id, sc.name FROM "ProductCategory" pc JOIN "ShopCategory" sc ON sc.id = pc."categoryId" AND sc."sellerId" = pc."sellerId"
        WHERE pc."productId" = p.id AND pc."sellerId" = p."sellerId" ORDER BY pc."createdAt", pc."categoryId" LIMIT 1) c ON true
      WHERE p."sellerId" = ${sid}::uuid`,
    tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "Product" p WHERE p."sellerId" = ${sid}::uuid AND p."deletedAt" IS NULL AND p.status <> 'DRAFT'`,
    tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM "RestockAlert" a WHERE a."sellerId" = ${sid}::uuid AND a."createdAt" >= ${range.start} AND a."createdAt" < ${range.end}`,
  ]);
  const unsoldIds = unsold.map((p) => p.id);
  const lastSold = unsoldIds.length
    ? await tx.$queryRaw<{ product_id: string; at: Date }[]>`
        SELECT i."productId" AS product_id, max(o."createdAt") AS at
        FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
        WHERE i."sellerId" = ${sid}::uuid AND i."productId" = ANY(${unsoldIds}::uuid[]) AND o.status = 'PAID' AND i.quantity > i."refundedQuantity"
        GROUP BY i."productId"`
    : [];
  const lastSoldAt = new Map(lastSold.map((r) => [r.product_id, r.at]));
  const info = new Map(catalog.map((c) => [c.id, c]));
  const prevOf = new Map(prevRows.map((r) => [r.product_id, { quantity: num(r.quantity), revenue: num(r.revenue) }]));
  const rows = current.map((r) => ({ productId: r.product_id, name: r.name, deleted: r.deleted, quantity: num(r.quantity), revenue: num(r.revenue), orders: num(r.orders) }));
  const totalRevenue = rows.reduce((a, r) => a + r.revenue, 0);
  // 카테고리별 매출: 지금 보이는(지우지 않은·임시 저장 아닌) 상품이 있는 카테고리와 판매가 있었던 카테고리. 미분류는 있을 때만.
  const cats = new Map<string | null, { categoryId: string | null; name: string; quantity: number; revenue: number }>();
  const bucket = (id: string | null, name: string | null) => {
    if (!cats.has(id)) cats.set(id, { categoryId: id, name: id ? (name ?? "") : "미분류", quantity: 0, revenue: 0 });
    return cats.get(id)!;
  };
  for (const c of catalog) if (!c.deleted && !c.draft && c.category_id) bucket(c.category_id, c.category_name);
  for (const r of rows) {
    const c = info.get(r.productId);
    const b = bucket(c?.category_id ?? null, c?.category_name ?? null);
    b.quantity += r.quantity;
    b.revenue += r.revenue;
  }
  const categories = [...cats.values()]
    .map((c) => ({ ...c, share: pct(c.revenue, totalRevenue) }))
    .sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity || a.name.localeCompare(b.name, "ko"));
  const withDetail = (r: (typeof rows)[number]) => {
    const c = info.get(r.productId);
    const prev = prevOf.get(r.productId);
    return {
      ...r,
      categoryId: c?.category_id ?? null,
      categoryName: c?.category_id ? c.category_name : "미분류",
      share: pct(r.revenue, totalRevenue),
      stock: num(c?.stock),
      previous: { quantity: prev?.quantity ?? 0, revenue: prev?.revenue ?? 0 },
    };
  };
  return {
    range: { from: range.from, to: range.to, unit: range.unit, previous: { from: range.prev.from, to: range.prev.to } },
    current: { quantity: rows.reduce((s, r) => s + r.quantity, 0), revenue: rows.reduce((s, r) => s + r.revenue, 0), products: rows.length },
    previous: { quantity: num(previous[0]?.quantity), revenue: num(previous[0]?.revenue), products: num(previous[0]?.products) },
    summary: {
      registered: num(registered[0]?.n),
      topShare: pct(rows.slice(0, TOP_SHARE_COUNT).reduce((a, r) => a + r.revenue, 0), totalRevenue),
      missedBySoldOut: num(missed[0]?.n),
    },
    categories,
    top: rows.slice(0, PRODUCT_TOP_LIMIT).map(withDetail),
    // 수량 기준 상위(매출 상위를 다시 정렬하지 않고, 팔린 상품 전체에서 고른다)
    topByQuantity: [...rows].sort((x, y) => y.quantity - x.quantity || y.revenue - x.revenue || (x.productId < y.productId ? -1 : 1)).slice(0, PRODUCT_TOP_LIMIT).map(withDetail),
    unsold: unsold.map((p) => ({ productId: p.id, name: p.name, status: p.status, createdAt: p.created_at, stock: num(info.get(p.id)?.stock), lastSoldAt: lastSoldAt.get(p.id) ?? null })),
    unsoldCount: num(unsoldCount[0]?.n),
  };
}
