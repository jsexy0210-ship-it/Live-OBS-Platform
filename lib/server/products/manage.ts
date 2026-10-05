import { Prisma, type EventDiscountType, type PrismaClient, type ProductStatus, type StockDeductMode } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { dbNow } from "../billing/subscription";
import { dbClock } from "../orders/overdue";
import { kstDayStart } from "../orders/read";
import { INT4_MAX } from "../orders/shipping";
import { cleanText } from "../text/clean";
import { parseSearchTags } from "../shop-search/service";
import { eventFits, eventOf, eventView } from "./event";
import { listProductImages, thumbnailUrls } from "./images";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 판매자 상품·옵션 관리(PRODUCT_MANAGE). 모든 조회·변경은 ctx.sellerId 범위이고 다른 판매자 상품은 없음(404)으로 본다.
// - 가격: 상품 가격 1원~INT4, 옵션을 더한 단가(가격 + 추가금)도 1원~INT4. 가격·추가금을 바꿀 때 살아 있는 옵션 전부로 다시 확인한다.
// - 재고: 0 이상 정수. 바꿀 때는 화면이 본 재고(expectedStock)가 지금과 같아야 한다(결제 차감과 겹쳐도 덮어쓰지 않음). 차이는 MANUAL 재고 이력.
// - 삭제는 소프트 삭제(지난 주문 품목이 참조). 지운 상품·옵션은 목록·새 주문에서 빠진다.
// - 판매 중(ON_SALE)은 살아 있는 옵션이 하나 이상 있어야 한다.

// 상품 코드(카페24식): 판매자별 순번 codeNo를 「P」 + 7자리로 보인다(1000만 번째부터는 자릿수가 늘어난다).
export const productCode = (codeNo: number) => `P${String(codeNo).padStart(7, "0")}`;
// 검색어가 상품 코드 모양(P 생략 가능, 숫자만)이면 그 번호. 아니면 null.
export function parseProductCode(term: string): number | null {
  const m = /^p?(\d{1,9})$/i.exec(term);
  return m && Number(m[1]) > 0 ? Number(m[1]) : null;
}

export const PRODUCT_STATUSES: readonly ProductStatus[] = ["DRAFT", "ON_SALE", "SOLD_OUT", "HIDDEN"];
export const MAX_OPTIONS_PER_PRODUCT = 100;

export type ProductFailure =
  | "invalid_product"
  | "product_name_too_long"
  | "invalid_option"
  | "invalid_price"
  | "too_many_options"
  | "no_sellable_option"
  | "stock_conflict"
  | "event_price_too_low"; // 이벤트 할인이 걸린 상품의 가격·옵션 추가금을 바꿔 할인 뒤 단가가 1원 미만이 됨

// 상품명은 공백 포함 100자(코드포인트, 대표님 결정 2026-10-03). 글자 검사는 통과하는데 길기만 하면 따로 알려 준다.
export const PRODUCT_NAME_MAX = 100;
function productName(v: unknown): { ok: true; name: string } | { ok: false; reason: "invalid_product" | "product_name_too_long" } {
  const name = line(v, PRODUCT_NAME_MAX);
  if (name) return { ok: true, name };
  return { ok: false, reason: line(v, Number.MAX_SAFE_INTEGER) ? "product_name_too_long" : "invalid_product" };
}
const STOCK_DEDUCT_MODES: readonly StockDeductMode[] = ["ORDER", "PAYMENT"];
export type ProductResult<T> = { ok: true; value: T } | { ok: false; reason: ProductFailure };

type Tx = Prisma.TransactionClient;
const fail = (reason: ProductFailure) => ({ ok: false as const, reason });

// 이름·SKU는 한 줄 글자, 설명은 줄바꿈만 허용(lib/server/text/clean.ts, 배송지와 같은 규칙)
const line = (v: unknown, max: number): string | null => cleanText(v, max, "name");
function multiline(v: unknown, max: number): string | null | undefined {
  if (v === null || v === undefined || (typeof v === "string" && v.trim() === "")) return null;
  return cleanText(v, max, "multiline") ?? undefined;
}
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const unitOk = (price: number, delta: number) => price + delta >= 1 && price + delta <= INT4_MAX;

// sortOrder가 없으면 null: 상품 등록 때는 입력 순서, 옵션 추가 때는 맨 뒤로 매긴다(같은 시각에 만든 옵션 순서가 흔들리지 않게)
type OptionInput = { name: string; priceDelta: number; stock: number; sku: string | null; sortOrder: number | null };

function parseNewOption(raw: unknown): OptionInput | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const name = line(b.name, 100);
  const priceDelta = b.priceDelta ?? 0;
  const stock = b.stock ?? 0;
  const sortOrder = b.sortOrder ?? null;
  const noSku = b.sku === undefined || b.sku === null || b.sku === "";
  const sku = noSku ? null : line(b.sku, 64);
  if (!name || (!noSku && sku === null)) return null;
  if (!isInt(priceDelta, -INT4_MAX, INT4_MAX) || !isInt(stock, 0, INT4_MAX) || (sortOrder !== null && !isInt(sortOrder, -100000, 100000))) return null;
  return { name, priceDelta, stock, sku, sortOrder };
}

// 지운 상품은 없는 상품으로 본다. 가격·옵션 검사가 다른 변경과 겹치지 않게 상품 행을 잠근다.
async function lockProduct(tx: Tx, sellerId: string, productId: string) {
  const rows = await tx.$queryRaw<
    {
      id: string;
      price: number;
      status: ProductStatus;
      eventDiscountType: EventDiscountType | null;
      eventDiscountValue: number | null;
      eventStartsAt: Date | null;
      eventEndsAt: Date | null;
    }[]
  >`
    SELECT "id", "price", "status"::text AS "status", "eventDiscountType"::text AS "eventDiscountType", "eventDiscountValue", "eventStartsAt", "eventEndsAt"
    FROM "Product"
    WHERE "id" = ${productId}::uuid AND "sellerId" = ${sellerId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
  if (!rows[0]) throw notFound();
  return rows[0];
}

const liveOptions = (tx: Tx | PrismaClient, sellerId: string, productId: string) =>
  tx.productOption.findMany({ where: { sellerId, productId, deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] });

async function productView(tx: Tx | PrismaClient, sellerId: string, productId: string) {
  const p = await tx.product.findFirstOrThrow({ where: { id: productId, sellerId } });
  const { deletedAt: _d, ...rest } = p;
  const event = eventView(eventOf(p), p.price, await dbNow(tx));
  return { ...rest, code: productCode(p.codeNo), event, images: await listProductImages(tx, sellerId, productId), options: (await liveOptions(tx, sellerId, productId)).map(({ deletedAt: _o, ...o }) => o) };
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
export const MAX_SEARCH_LENGTH = 50;
// 재고 기준 필터(화면 「재고 없음」·「재고 적음」 배지·탭과 같은 기준). 지운 옵션은 빼고 살아 있는 옵션 재고를 더한다.
// out: 합계 0(옵션이 없는 상품 포함), low: 1~LOW_STOCK_MAX. 판매 상태와 상관없이 고르고, status와 함께 쓸 수 있다.
export const LOW_STOCK_MAX = 5;
const STOCK_FILTERS = { out: [0, 0], low: [1, LOW_STOCK_MAX] } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 쪽 크기: 숫자 또는 숫자만 있는 문자열(1~200)만 받는다("1e2", "0x10", " 5 "는 거부). 빼면 기본 50. 틀리면 null.
export function parsePageLimit(raw: unknown): number | null {
  const limit = raw === undefined ? DEFAULT_PAGE_SIZE : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE ? limit : null;
}

// 이름 검색어: 저장할 때처럼 NFKC로 맞추고 앞뒤 공백을 지운 뒤 50자까지. 비었거나 일반 공백(U+0020)뿐이면 검색하지 않는다(null).
// 탭·줄바꿈·BOM·폭 없는 공백 같은 제어·서식 문자만 있으면(trim으로 지워져도) cleanText가 막아 "invalid".
export function parseSearchTerm(raw: unknown): string | null | "invalid" {
  if (raw === undefined || (typeof raw === "string" && /^ *$/.test(raw))) return null;
  return cleanText(raw, MAX_SEARCH_LENGTH) ?? "invalid";
}

// 재고 조건(out·low)의 범위. 빼거나 비었으면 null, 틀리면 "invalid".
export function parseStockFilter(raw: unknown): readonly [number, number] | null | "invalid" {
  if (raw === undefined || raw === "") return null;
  return raw === "out" || raw === "low" ? STOCK_FILTERS[raw] : "invalid";
}

// 정렬(sort): 빼면 진열 순서 → 최근 등록. newest(최근 등록), sales(판매량 많은 순), price_asc·price_desc(가격). 같으면 id 순.
// 판매량은 결제 완료(PAID) 주문의 품목 수량 합이다(취소·환불·입금 전 주문 제외). 목록 응답의 soldQuantity와 같은 기준.
export const PRODUCT_SORTS = ["newest", "sales", "price_asc", "price_desc"] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
// 노출 상태(display): shown = 쇼핑몰에 보이는 상품(판매 중·품절), hidden = 안 보이는 상품(판매 대기·숨김)
const DISPLAY_STATUSES = { shown: ["ON_SALE", "SOLD_OUT"], hidden: ["DRAFT", "HIDDEN"] } as const satisfies Record<string, readonly ProductStatus[]>;
export const MAX_CODE_LENGTH = 64;

type ListFailure =
  | "invalid_cursor"
  | "invalid_limit"
  | "invalid_stock_filter"
  | "invalid_search"
  | "invalid_sort"
  | "invalid_date_range"
  | "invalid_code"
  | "invalid_stock_deduct_mode"
  | "invalid_display"
  | "invalid_category";

export type ProductListQuery = {
  status?: unknown;
  display?: unknown;
  stock?: unknown;
  q?: unknown;
  code?: unknown;
  stockDeductMode?: unknown;
  createdFrom?: unknown;
  createdTo?: unknown;
  sort?: unknown;
  categoryId?: unknown;
  cursor?: unknown;
  limit?: unknown;
};

// 등록일 기간(KST 날짜 YYYY-MM-DD, 양 끝 포함). 둘 다 빼면 null, 하나만 써도 된다. 없는 날짜·시작 > 종료는 "invalid".
export function parseCreatedRange(from: unknown, to: unknown): { gte: Date | null; lt: Date | null } | null | "invalid" {
  const day = (v: unknown) => (v === undefined || v === "" ? null : typeof v === "string" ? (kstDayStart(v) ?? "invalid") : "invalid");
  const f = day(from);
  const t = day(to);
  if (f === "invalid" || t === "invalid") return "invalid";
  if (!f && !t) return null;
  if (f && t && f > t) return "invalid";
  return { gte: f, lt: t ? new Date(t.getTime() + 24 * 3600_000) : null };
}

// 상품 목록(keyset 커서 페이지). 기본 정렬: 진열 순서 → 최근 등록 → id. nextCursor가 null이면 마지막 쪽이에요.
// 커서는 이 판매자 상품 id만 받고, 그 행의 지금 정렬 값 바로 뒤부터 고른다.
// 기준 상품이 그사이 지워졌거나 필터 밖이 되어도 값만 쓰므로 다음 상품을 건너뛰지 않는다.
// 판매량순은 쪽을 넘기는 사이 판매량이 바뀐 상품이 앞뒤 쪽에서 한 번 더 보이거나 빠질 수 있다(가격·등록일 정렬은 그대로).
// limit은 숫자 또는 숫자만 있는 문자열(1~200)만 받는다("1e2", "0x10", " 5 "는 거부).
export async function listProducts(
  db: PrismaClient,
  ctx: TenantContext,
  opts: ProductListQuery = {},
): Promise<
  | { ok: true; value: { products: (Omit<Awaited<ReturnType<typeof productView>>, "images"> & { soldQuantity: number; thumbnailUrl: string | null })[]; nextCursor: string | null } }
  | { ok: false; reason: ListFailure }
> {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const status = PRODUCT_STATUSES.includes(opts.status as ProductStatus) ? (opts.status as ProductStatus) : undefined;
  const limit = parsePageLimit(opts.limit);
  if (limit === null) return { ok: false, reason: "invalid_limit" };
  const sort = opts.sort === undefined || opts.sort === "" ? null : PRODUCT_SORTS.includes(opts.sort as ProductSort) ? (opts.sort as ProductSort) : "invalid";
  if (sort === "invalid") return { ok: false, reason: "invalid_sort" };
  let display: readonly ProductStatus[] | undefined;
  if (opts.display !== undefined && opts.display !== "") {
    if (opts.display !== "shown" && opts.display !== "hidden") return { ok: false, reason: "invalid_display" };
    display = DISPLAY_STATUSES[opts.display];
  }
  let deductMode: StockDeductMode | undefined;
  if (opts.stockDeductMode !== undefined && opts.stockDeductMode !== "") {
    if (!STOCK_DEDUCT_MODES.includes(opts.stockDeductMode as StockDeductMode)) return { ok: false, reason: "invalid_stock_deduct_mode" };
    deductMode = opts.stockDeductMode as StockDeductMode;
  }
  const created = parseCreatedRange(opts.createdFrom, opts.createdTo);
  if (created === "invalid") return { ok: false, reason: "invalid_date_range" };
  // 필터·정렬·커서는 모두 SQL 안에서 걸러 이번 쪽의 상품 id(최대 limit + 1개)만 고른다. 걸러진 id 목록을 IN으로 넘기면
  // 결과가 Postgres 바인드 변수 한도(32,767)를 넘을 때 오류가 나므로 쓰지 않는다.
  const where: Prisma.Sql[] = [Prisma.sql`p."sellerId" = ${ctx.sellerId}::uuid`, Prisma.sql`p."deletedAt" IS NULL`];
  if (status) where.push(Prisma.sql`p."status" = ${status}::"ProductStatus"`);
  if (display) where.push(Prisma.sql`p."status"::text IN (${Prisma.join(display)})`);
  if (deductMode) where.push(Prisma.sql`p."stockDeductMode" = ${deductMode}::"StockDeductMode"`);
  if (created?.gte) where.push(Prisma.sql`p."createdAt" >= ${created.gte}`);
  if (created?.lt) where.push(Prisma.sql`p."createdAt" < ${created.lt}`);
  let stockJoin = Prisma.empty;
  const stockRange = parseStockFilter(opts.stock);
  if (stockRange === "invalid") return { ok: false, reason: "invalid_stock_filter" };
  if (stockRange) {
    const [lo, hi] = stockRange;
    // 판매자 옵션 재고를 상품별로 한 번만 더해 붙인다(상관 서브쿼리에 BETWEEN을 걸면 합계를 두 번 계산해 느려진다).
    // 옵션이 없는 상품은 합계 0.
    stockJoin = Prisma.sql`LEFT JOIN (
      SELECT o."productId", SUM(o."stock") AS "total" FROM "ProductOption" o
      WHERE o."sellerId" = ${ctx.sellerId}::uuid AND o."deletedAt" IS NULL
      GROUP BY o."productId") st ON st."productId" = p."id"`;
    where.push(Prisma.sql`COALESCE(st."total", 0) BETWEEN ${lo} AND ${hi}`);
  }
  // 이름 검색 q(parseSearchTerm): 상품 이름이나 (지우지 않은) 옵션 이름에 들어 있으면(대소문자 무시, 부분 일치).
  // %·_ 같은 글자도 그대로 찾는다(LIKE 패턴으로 쓰지 않음). 옵션은 판매자 범위((sellerId, productId) 인덱스)로 좁혀서 본다.
  const term = parseSearchTerm(opts.q);
  if (term === "invalid") return { ok: false, reason: "invalid_search" };
  if (term) {
    where.push(Prisma.sql`(strpos(lower(p."name"), lower(${term})) > 0
      OR EXISTS (SELECT 1 FROM "ProductOption" o
                 WHERE o."sellerId" = ${ctx.sellerId}::uuid AND o."productId" = p."id" AND o."deletedAt" IS NULL
                   AND strpos(lower(o."name"), lower(${term})) > 0))`);
  }
  // 상품 코드 code: 상품 코드(P0000012, P·앞자리 0 생략 가능)가 같거나, 상품 id 전체가 같거나, (지우지 않은) 옵션 SKU에 들어 있으면(대소문자 무시, 부분 일치).
  const code = opts.code === undefined || (typeof opts.code === "string" && /^ *$/.test(opts.code)) ? null : (cleanText(opts.code, MAX_CODE_LENGTH) ?? "invalid");
  if (code === "invalid") return { ok: false, reason: "invalid_code" };
  if (code) {
    const codeNo = parseProductCode(code);
    where.push(Prisma.sql`(p."id"::text = lower(${code}) OR p."codeNo" = ${codeNo ?? -1}
      OR EXISTS (SELECT 1 FROM "ProductOption" o
                 WHERE o."sellerId" = ${ctx.sellerId}::uuid AND o."productId" = p."id" AND o."deletedAt" IS NULL
                   AND o."sku" IS NOT NULL AND strpos(lower(o."sku"), lower(${code})) > 0))`);
  }
  // 카테고리 categoryId: 그 카테고리에 지정한 상품. 대분류면 그 아래 소분류에 지정한 상품도 함께. 이 판매자 카테고리가 아니면 400.
  if (opts.categoryId !== undefined && opts.categoryId !== "") {
    if (typeof opts.categoryId !== "string" || !UUID.test(opts.categoryId)) return { ok: false, reason: "invalid_category" };
    const cat = await db.shopCategory.findFirst({ where: { id: opts.categoryId, sellerId: ctx.sellerId }, select: { id: true } });
    if (!cat) return { ok: false, reason: "invalid_category" };
    where.push(Prisma.sql`EXISTS (SELECT 1 FROM "ProductCategory" pc JOIN "ShopCategory" c ON c."sellerId" = pc."sellerId" AND c."id" = pc."categoryId"
      WHERE pc."sellerId" = ${ctx.sellerId}::uuid AND pc."productId" = p."id" AND (c."id" = ${cat.id}::uuid OR c."parentId" = ${cat.id}::uuid))`);
  }
  // 판매량: 결제 완료 주문 품목 수량을 상품별로 한 번만 더해 붙인다(판매량순 정렬·커서에만 쓴다)
  const soldJoin =
    sort === "sales"
      ? Prisma.sql`LEFT JOIN (
      SELECT oi."productId", SUM(oi."quantity") AS "sold" FROM "OrderItem" oi
      JOIN "Order" od ON od."sellerId" = oi."sellerId" AND od."id" = oi."orderId"
      WHERE oi."sellerId" = ${ctx.sellerId}::uuid AND od."status" = 'PAID'
      GROUP BY oi."productId") sd ON sd."productId" = p."id"`
      : Prisma.empty;
  const sold = Prisma.sql`COALESCE(sd."sold", 0)`;
  if (opts.cursor !== undefined && opts.cursor !== "") {
    if (typeof opts.cursor !== "string" || !UUID.test(opts.cursor)) return { ok: false, reason: "invalid_cursor" };
    const rows = await db.$queryRaw<{ id: string; sortOrder: number; createdAt: Date; price: number; sold: bigint }[]>`
      SELECT p."id", p."sortOrder", p."createdAt", p."price", ${sort === "sales" ? sold : Prisma.sql`0`}::bigint AS "sold"
      FROM "Product" p ${soldJoin}
      WHERE p."id" = ${opts.cursor}::uuid AND p."sellerId" = ${ctx.sellerId}::uuid`;
    const c = rows[0];
    if (!c) return { ok: false, reason: "invalid_cursor" };
    const after = (col: Prisma.Sql, v: unknown, dir: "<" | ">") =>
      Prisma.sql`(${col} ${Prisma.raw(dir)} ${v} OR (${col} = ${v} AND p."id" > ${c.id}::uuid))`;
    if (sort === "newest") where.push(after(Prisma.sql`p."createdAt"`, c.createdAt, "<"));
    else if (sort === "price_asc") where.push(after(Prisma.sql`p."price"`, c.price, ">"));
    else if (sort === "price_desc") where.push(after(Prisma.sql`p."price"`, c.price, "<"));
    else if (sort === "sales") where.push(after(sold, c.sold, "<"));
    else {
      where.push(Prisma.sql`(p."sortOrder" > ${c.sortOrder}
      OR (p."sortOrder" = ${c.sortOrder} AND p."createdAt" < ${c.createdAt})
      OR (p."sortOrder" = ${c.sortOrder} AND p."createdAt" = ${c.createdAt} AND p."id" > ${c.id}::uuid))`);
    }
  }
  const orderBy =
    sort === "newest"
      ? Prisma.sql`p."createdAt" DESC, p."id" ASC`
      : sort === "price_asc"
        ? Prisma.sql`p."price" ASC, p."id" ASC`
        : sort === "price_desc"
          ? Prisma.sql`p."price" DESC, p."id" ASC`
          : sort === "sales"
            ? Prisma.sql`${sold} DESC, p."id" ASC`
            : Prisma.sql`p."sortOrder" ASC, p."createdAt" DESC, p."id" ASC`;
  const ids = await db.$queryRaw<{ id: string }[]>`
    SELECT p."id" FROM "Product" p
    ${stockJoin}
    ${soldJoin}
    WHERE ${Prisma.join(where, " AND ")}
    ORDER BY ${orderBy}
    LIMIT ${limit + 1}`;
  // 두 조회 사이에 지워졌거나 상태가 바뀐 상품이 응답에 섞이지 않게 같은 조건을 다시 건다
  const statusIn = status ? [status] : display;
  const found = await db.product.findMany({
    where: { sellerId: ctx.sellerId, deletedAt: null, ...(statusIn ? { status: { in: [...statusIn] } } : {}), id: { in: ids.map((r) => r.id) } },
    include: { options: { where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] } },
  });
  const byId = new Map(found.map((p) => [p.id, p]));
  // 고른 순서대로. 두 조회 사이에 지워진 상품은 빠지지만, 다음 쪽 커서는 고른 id 기준이라 뒤 상품을 건너뛰지 않는다.
  const pageIds = ids.slice(0, limit).map((r) => r.id);
  const page = pageIds.map((id) => byId.get(id)).filter((p): p is (typeof found)[number] => p !== undefined);
  const soldRows = await db.$queryRaw<{ productId: string; sold: bigint }[]>`
    SELECT oi."productId", SUM(oi."quantity")::bigint AS "sold" FROM "OrderItem" oi
    JOIN "Order" od ON od."sellerId" = oi."sellerId" AND od."id" = oi."orderId"
    WHERE oi."sellerId" = ${ctx.sellerId}::uuid AND od."status" = 'PAID' AND oi."productId" = ANY(${page.map((p) => p.id)}::uuid[])
    GROUP BY oi."productId"`;
  const soldBy = new Map(soldRows.map((r) => [r.productId, Number(r.sold)]));
  const thumbs = await thumbnailUrls(db, ctx.sellerId, page.map((p) => p.id));
  const now = await dbNow(db);
  return {
    ok: true,
    value: {
      products: page.map(({ deletedAt: _d, options, ...p }) => ({
        ...p,
        code: productCode(p.codeNo),
        event: eventView(eventOf(p), p.price, now),
        soldQuantity: soldBy.get(p.id) ?? 0,
        thumbnailUrl: thumbs.get(p.id) ?? null,
        options: options.map(({ deletedAt: _o, ...o }) => o),
      })),
      nextCursor: ids.length > limit ? pageIds[pageIds.length - 1] : null,
    },
  };
}

export async function getProduct(db: PrismaClient, ctx: TenantContext, productId: string) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const p = await db.product.findFirst({ where: { id: productId, sellerId: ctx.sellerId, deletedAt: null }, select: { id: true } });
  if (!p) throw notFound();
  return productView(db, ctx.sellerId, productId);
}

export type NewProductInput = {
  name: string;
  description: string | null;
  searchTags: string[];
  price: number;
  status: ProductStatus;
  sortOrder: number;
  stockDeductMode: StockDeductMode;
  options: (OptionInput & { sortOrder: number })[];
};

// 상품 등록 입력 검증(DB 접근 없음). 상품 등록과 엑셀 일괄 등록 미리보기(bulk-io)가 같은 규칙을 쓴다.
export function parseNewProduct(raw: unknown): ProductResult<NewProductInput> {
  if (!raw || typeof raw !== "object") return fail("invalid_product");
  const b = raw as Record<string, unknown>;
  const named = productName(b.name);
  if (!named.ok) return fail(named.reason);
  const name = named.name;
  const description = multiline(b.description, 5000);
  const status = b.status ?? "DRAFT";
  const sortOrder = b.sortOrder ?? 0;
  const stockDeductMode = b.stockDeductMode ?? "PAYMENT";
  const searchTags = parseSearchTags(b.searchTags);
  if (
    searchTags === null ||
    description === undefined ||
    !PRODUCT_STATUSES.includes(status as ProductStatus) ||
    !isInt(sortOrder, -100000, 100000) ||
    !STOCK_DEDUCT_MODES.includes(stockDeductMode as StockDeductMode)
  ) {
    return fail("invalid_product");
  }
  if (!isInt(b.price, 1, INT4_MAX)) return fail("invalid_price");
  const price = b.price;
  const rawOptions = b.options ?? [];
  if (!Array.isArray(rawOptions)) return fail("invalid_option");
  if (rawOptions.length > MAX_OPTIONS_PER_PRODUCT) return fail("too_many_options");
  const options: (OptionInput & { sortOrder: number })[] = [];
  for (const [index, r] of rawOptions.entries()) {
    const o = parseNewOption(r);
    if (!o) return fail("invalid_option");
    if (!unitOk(price, o.priceDelta)) return fail("invalid_price");
    options.push({ ...o, sortOrder: o.sortOrder ?? index });
  }
  if (status === "ON_SALE" && options.length === 0) return fail("no_sellable_option");
  return { ok: true, value: { name, description, searchTags, price, status: status as ProductStatus, sortOrder, stockDeductMode: stockDeductMode as StockDeductMode, options } };
}

export async function createProduct(db: PrismaClient, ctx: TenantContext, raw: unknown): Promise<ProductResult<Awaited<ReturnType<typeof productView>>>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const parsed = parseNewProduct(raw);
  if (!parsed.ok) return parsed;
  const { name, description, searchTags, price, status, sortOrder, stockDeductMode, options } = parsed.value;

  return db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const product = await tx.product.create({
      data: { sellerId: ctx.sellerId, name, description, searchTags, price, status, sortOrder, stockDeductMode, createdAt: now },
    });
    for (const o of options) {
      const created = await tx.productOption.create({ data: { sellerId: ctx.sellerId, productId: product.id, ...o, createdAt: now } });
      if (o.stock > 0) await stockLog(tx, ctx, created.id, o.stock, now, STOCK_NOTES.initial);
    }
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product.create",
      targetType: "Product",
      targetId: product.id,
      after: { name, price, status, options: options.length },
    });
    return { ok: true as const, value: await productView(tx, ctx.sellerId, product.id) };
  });
}

export async function updateProduct(
  db: PrismaClient,
  ctx: TenantContext,
  productId: string,
  raw: unknown,
): Promise<ProductResult<Awaited<ReturnType<typeof productView>>>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (!raw || typeof raw !== "object") return fail("invalid_product");
  const b = raw as Record<string, unknown>;
  const data: Prisma.ProductUpdateInput = {};
  if (b.name !== undefined) {
    const named = productName(b.name);
    if (!named.ok) return fail(named.reason);
    data.name = named.name;
  }
  if (b.stockDeductMode !== undefined) {
    // 바꾸면 다음 주문부터 적용된다. 이미 받은 주문은 품목마다 남긴 차감 시각(stockDeductedAt)대로 처리한다.
    if (!STOCK_DEDUCT_MODES.includes(b.stockDeductMode as StockDeductMode)) return fail("invalid_product");
    data.stockDeductMode = b.stockDeductMode as StockDeductMode;
  }
  if (b.description !== undefined) {
    const description = multiline(b.description, 5000);
    if (description === undefined) return fail("invalid_product");
    data.description = description;
  }
  if (b.searchTags !== undefined) {
    const searchTags = parseSearchTags(b.searchTags);
    if (searchTags === null) return fail("invalid_product");
    data.searchTags = searchTags;
  }
  if (b.status !== undefined) {
    if (!PRODUCT_STATUSES.includes(b.status as ProductStatus)) return fail("invalid_product");
    data.status = b.status as ProductStatus;
  }
  if (b.sortOrder !== undefined) {
    if (!isInt(b.sortOrder, -100000, 100000)) return fail("invalid_product");
    data.sortOrder = b.sortOrder;
  }
  if (b.price !== undefined) {
    if (!isInt(b.price, 1, INT4_MAX)) return fail("invalid_price");
    data.price = b.price;
  }
  if (Object.keys(data).length === 0) return fail("invalid_product");

  return db.$transaction(async (tx) => {
    const before = await lockProduct(tx, ctx.sellerId, productId);
    const options = await liveOptions(tx, ctx.sellerId, productId);
    const price = (data.price as number | undefined) ?? before.price;
    if (options.some((o) => !unitOk(price, o.priceDelta))) return fail("invalid_price");
    // 이벤트 할인이 걸려 있으면 바뀐 가격에서도 할인 뒤 단가가 1원 이상이어야 한다
    if (!eventFits(eventOf(before), price, [0, ...options.map((o) => o.priceDelta)], await dbClock(tx))) return fail("event_price_too_low");
    if ((data.status ?? before.status) === "ON_SALE" && options.length === 0) return fail("no_sellable_option");
    await tx.product.update({ where: { id: productId }, data });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product.update",
      targetType: "Product",
      targetId: productId,
      before: { price: before.price, status: before.status },
      after: data,
    });
    return { ok: true as const, value: await productView(tx, ctx.sellerId, productId) };
  });
}

export async function deleteProduct(db: PrismaClient, ctx: TenantContext, productId: string): Promise<void> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  await db.$transaction(async (tx) => {
    await lockProduct(tx, ctx.sellerId, productId);
    const now = await dbNow(tx);
    await tx.product.update({ where: { id: productId }, data: { deletedAt: now } });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "product.delete", targetType: "Product", targetId: productId });
  });
}

export async function createOption(db: PrismaClient, ctx: TenantContext, productId: string, raw: unknown) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const o = parseNewOption(raw);
  if (!o) return fail("invalid_option");
  return db.$transaction(async (tx) => {
    const product = await lockProduct(tx, ctx.sellerId, productId);
    if (!unitOk(product.price, o.priceDelta)) return fail("invalid_price");
    if (!eventFits(eventOf(product), product.price, [o.priceDelta], await dbClock(tx))) return fail("event_price_too_low");
    if ((await tx.productOption.count({ where: { sellerId: ctx.sellerId, productId, deletedAt: null } })) >= MAX_OPTIONS_PER_PRODUCT) {
      return fail("too_many_options");
    }
    const now = await dbNow(tx);
    const last = await tx.productOption.aggregate({ where: { sellerId: ctx.sellerId, productId, deletedAt: null }, _max: { sortOrder: true } });
    const sortOrder = o.sortOrder ?? Math.min((last._max.sortOrder ?? -1) + 1, 100000);
    const option = await tx.productOption.create({ data: { sellerId: ctx.sellerId, productId, ...o, sortOrder, createdAt: now } });
    if (o.stock > 0) await stockLog(tx, ctx, option.id, o.stock, now, STOCK_NOTES.initial);
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product_option.create",
      targetType: "ProductOption",
      targetId: option.id,
      after: { productId, name: o.name, priceDelta: o.priceDelta, stock: o.stock },
    });
    return { ok: true as const, value: await productView(tx, ctx.sellerId, productId) };
  });
}

export async function updateOption(db: PrismaClient, ctx: TenantContext, productId: string, optionId: string, raw: unknown) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (!raw || typeof raw !== "object") return fail("invalid_option");
  const b = raw as Record<string, unknown>;
  const data: Prisma.ProductOptionUpdateInput = {};
  if (b.name !== undefined) {
    const name = line(b.name, 100);
    if (!name) return fail("invalid_option");
    data.name = name;
  }
  if (b.sku !== undefined) {
    const sku = b.sku === null || b.sku === "" ? null : line(b.sku, 64);
    if (sku === null && b.sku !== null && b.sku !== "") return fail("invalid_option");
    data.sku = sku;
  }
  if (b.sortOrder !== undefined) {
    if (!isInt(b.sortOrder, -100000, 100000)) return fail("invalid_option");
    data.sortOrder = b.sortOrder;
  }
  if (b.priceDelta !== undefined) {
    if (!isInt(b.priceDelta, -INT4_MAX, INT4_MAX)) return fail("invalid_price");
    data.priceDelta = b.priceDelta;
  }
  const stockChange = b.stock !== undefined || b.expectedStock !== undefined;
  if (stockChange && (!isInt(b.stock, 0, INT4_MAX) || !isInt(b.expectedStock, 0, INT4_MAX))) return fail("invalid_option");
  if (Object.keys(data).length === 0 && !stockChange) return fail("invalid_option");

  return db.$transaction(async (tx) => {
    const product = await lockProduct(tx, ctx.sellerId, productId);
    const option = await tx.productOption.findFirst({ where: { id: optionId, sellerId: ctx.sellerId, productId, deletedAt: null } });
    if (!option) throw notFound();
    if (data.priceDelta !== undefined && !unitOk(product.price, data.priceDelta as number)) return fail("invalid_price");
    if (data.priceDelta !== undefined && !eventFits(eventOf(product), product.price, [data.priceDelta as number], await dbClock(tx))) {
      return fail("event_price_too_low");
    }
    const now = await dbNow(tx);
    if (stockChange) {
      const stock = b.stock as number;
      const expectedStock = b.expectedStock as number;
      // 결제 차감과 겹치면 화면이 본 값과 달라지므로 덮어쓰지 않는다
      const moved = await tx.productOption.updateMany({ where: { id: optionId, sellerId: ctx.sellerId, stock: expectedStock }, data: { stock } });
      if (moved.count !== 1) return fail("stock_conflict");
      if (stock !== expectedStock) await stockLog(tx, ctx, optionId, stock - expectedStock, now, STOCK_NOTES.bulkEdit);
    }
    if (Object.keys(data).length > 0) await tx.productOption.update({ where: { id: optionId }, data });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product_option.update",
      targetType: "ProductOption",
      targetId: optionId,
      before: { priceDelta: option.priceDelta, stock: option.stock },
      after: { ...data, ...(stockChange ? { stock: b.stock } : {}) },
    });
    return { ok: true as const, value: await productView(tx, ctx.sellerId, productId) };
  });
}

export async function deleteOption(db: PrismaClient, ctx: TenantContext, productId: string, optionId: string) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  return db.$transaction(async (tx) => {
    const product = await lockProduct(tx, ctx.sellerId, productId);
    const option = await tx.productOption.findFirst({ where: { id: optionId, sellerId: ctx.sellerId, productId, deletedAt: null }, select: { id: true } });
    if (!option) throw notFound();
    // 판매 중 상품의 마지막 옵션은 지우지 않는다(먼저 판매 상태를 바꾼다)
    if (product.status === "ON_SALE" && (await tx.productOption.count({ where: { sellerId: ctx.sellerId, productId, deletedAt: null } })) === 1) {
      return fail("no_sellable_option");
    }
    const now = await dbNow(tx);
    await tx.productOption.update({ where: { id: optionId }, data: { deletedAt: now } });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "product_option.delete", targetType: "ProductOption", targetId: optionId });
    return { ok: true as const, value: await productView(tx, ctx.sellerId, productId) };
  });
}

// 직접 바꾼 재고(MANUAL)는 사유와 함께 남긴다(PRODUCT_SCOPE 「수동 재고 차감」). 등록·「변경 후」 일괄 적용은 사유 입력이 없어 정해진 문구를 쓴다.
export const STOCK_NOTES = { initial: "처음 재고", bulkEdit: "재고 일괄 수정" } as const;

function stockLog(tx: Tx, ctx: TenantContext, optionId: string, delta: number, now: Date, note: string) {
  return tx.stockMovement.create({
    data: { sellerId: ctx.sellerId, optionId, delta, reason: "MANUAL", note, actorType: ctx.actorType, actorId: ctx.actorId, createdAt: now },
  });
}
