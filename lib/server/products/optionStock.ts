import { Prisma, type PrismaClient, type ProductStatus } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { PRODUCT_STATUSES, parsePageLimit, parseSearchTerm, parseStockFilter } from "./manage";

// 옵션 단위 재고 목록(화면 SA-014 재고 관리, PRODUCT_MANAGE). 재고 조건은 옵션마다 본다(상품 목록의 stock 필터는 상품 합계).
// - stock: out(재고 0) · low(1~LOW_STOCK_MAX). q: 상품 이름이나 그 옵션 이름에 들어 있으면(대소문자 무시, 부분 일치).
//   status: 상품 판매 상태. 지운 상품·옵션은 빼고, 다른 쇼핑몰 것은 나오지 않는다.
// - 정렬: 상품 목록과 같은 순서(진열 순서 → 최근 등록 → id) 다음 옵션 순서(진열 순서 → 등록 → id).
// - 커서: 마지막 옵션 id. 그 행의 정렬 값 바로 뒤부터 고른다(그사이 지워졌거나 조건 밖이 되어도 값만 쓰므로 건너뛰지 않는다).
// 필터·정렬·커서는 SQL 하나에서 거르고 쪽 크기(limit + 1)만큼만 읽는다.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OptionStockRow = {
  productId: string;
  productName: string;
  productStatus: ProductStatus;
  optionId: string;
  optionName: string;
  sku: string | null;
  stock: number;
};

type Failure = "invalid_cursor" | "invalid_limit" | "invalid_stock_filter" | "invalid_search";

export async function listOptionStock(
  db: PrismaClient,
  ctx: TenantContext,
  opts: { status?: unknown; stock?: unknown; q?: unknown; cursor?: unknown; limit?: unknown } = {},
): Promise<{ ok: true; value: { options: OptionStockRow[]; nextCursor: string | null } } | { ok: false; reason: Failure }> {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const limit = parsePageLimit(opts.limit);
  if (limit === null) return { ok: false, reason: "invalid_limit" };
  const stockRange = parseStockFilter(opts.stock);
  if (stockRange === "invalid") return { ok: false, reason: "invalid_stock_filter" };
  const term = parseSearchTerm(opts.q);
  if (term === "invalid") return { ok: false, reason: "invalid_search" };
  const status = PRODUCT_STATUSES.includes(opts.status as ProductStatus) ? (opts.status as ProductStatus) : undefined;

  const where: Prisma.Sql[] = [
    Prisma.sql`o."sellerId" = ${ctx.sellerId}::uuid`,
    Prisma.sql`o."deletedAt" IS NULL`,
    Prisma.sql`p."deletedAt" IS NULL`,
  ];
  if (status) where.push(Prisma.sql`p."status" = ${status}::"ProductStatus"`);
  if (stockRange) where.push(Prisma.sql`o."stock" BETWEEN ${stockRange[0]} AND ${stockRange[1]}`);
  if (term) where.push(Prisma.sql`(strpos(lower(p."name"), lower(${term})) > 0 OR strpos(lower(o."name"), lower(${term})) > 0)`);
  if (opts.cursor !== undefined && opts.cursor !== "") {
    if (typeof opts.cursor !== "string" || !UUID.test(opts.cursor)) return { ok: false, reason: "invalid_cursor" };
    const c = await db.productOption.findFirst({
      where: { id: opts.cursor, sellerId: ctx.sellerId },
      select: { id: true, sortOrder: true, createdAt: true, product: { select: { id: true, sortOrder: true, createdAt: true } } },
    });
    if (!c) return { ok: false, reason: "invalid_cursor" };
    const cp = c.product;
    where.push(Prisma.sql`(p."sortOrder" > ${cp.sortOrder}
      OR (p."sortOrder" = ${cp.sortOrder} AND p."createdAt" < ${cp.createdAt})
      OR (p."sortOrder" = ${cp.sortOrder} AND p."createdAt" = ${cp.createdAt} AND p."id" > ${cp.id}::uuid)
      OR (p."id" = ${cp.id}::uuid AND (o."sortOrder", o."createdAt", o."id") > (${c.sortOrder}, ${c.createdAt}, ${c.id}::uuid)))`);
  }
  const rows = await db.$queryRaw<OptionStockRow[]>`
    SELECT p."id" AS "productId", p."name" AS "productName", p."status"::text AS "productStatus",
           o."id" AS "optionId", o."name" AS "optionName", o."sku", o."stock"
    FROM "ProductOption" o
    JOIN "Product" p ON p."id" = o."productId" AND p."sellerId" = o."sellerId"
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY p."sortOrder" ASC, p."createdAt" DESC, p."id" ASC, o."sortOrder" ASC, o."createdAt" ASC, o."id" ASC
    LIMIT ${limit + 1}`;
  const page = rows.slice(0, limit);
  return { ok: true, value: { options: page, nextCursor: rows.length > limit ? page[page.length - 1].optionId : null } };
}
