import type { Prisma, PrismaClient, ProductStatus, StockDeductMode } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { dbNow } from "../billing/subscription";
import { INT4_MAX } from "../orders/shipping";
import { cleanText } from "../text/clean";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 판매자 상품·옵션 관리(PRODUCT_MANAGE). 모든 조회·변경은 ctx.sellerId 범위이고 다른 판매자 상품은 없음(404)으로 본다.
// - 가격: 상품 가격 1원~INT4, 옵션을 더한 단가(가격 + 추가금)도 1원~INT4. 가격·추가금을 바꿀 때 살아 있는 옵션 전부로 다시 확인한다.
// - 재고: 0 이상 정수. 바꿀 때는 화면이 본 재고(expectedStock)가 지금과 같아야 한다(결제 차감과 겹쳐도 덮어쓰지 않음). 차이는 MANUAL 재고 이력.
// - 삭제는 소프트 삭제(지난 주문 품목이 참조). 지운 상품·옵션은 목록·새 주문에서 빠진다.
// - 판매 중(ON_SALE)은 살아 있는 옵션이 하나 이상 있어야 한다.

export const PRODUCT_STATUSES: readonly ProductStatus[] = ["DRAFT", "ON_SALE", "SOLD_OUT", "HIDDEN"];
export const MAX_OPTIONS_PER_PRODUCT = 100;

export type ProductFailure =
  | "invalid_product"
  | "product_name_too_long"
  | "invalid_option"
  | "invalid_price"
  | "too_many_options"
  | "no_sellable_option"
  | "stock_conflict";

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
  const rows = await tx.$queryRaw<{ id: string; price: number; status: ProductStatus }[]>`
    SELECT "id", "price", "status"::text AS "status" FROM "Product"
    WHERE "id" = ${productId}::uuid AND "sellerId" = ${sellerId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
  if (!rows[0]) throw notFound();
  return rows[0];
}

const liveOptions = (tx: Tx | PrismaClient, sellerId: string, productId: string) =>
  tx.productOption.findMany({ where: { sellerId, productId, deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] });

async function productView(tx: Tx | PrismaClient, sellerId: string, productId: string) {
  const p = await tx.product.findFirstOrThrow({ where: { id: productId, sellerId } });
  const { deletedAt: _d, ...rest } = p;
  return { ...rest, options: (await liveOptions(tx, sellerId, productId)).map(({ deletedAt: _o, ...o }) => o) };
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
// 재고 기준 필터(화면 「재고 없음」·「재고 적음」 배지·탭과 같은 기준). 지운 옵션은 빼고 살아 있는 옵션 재고를 더한다.
// out: 합계 0(옵션이 없는 상품 포함), low: 1~LOW_STOCK_MAX. 판매 상태와 상관없이 고르고, status와 함께 쓸 수 있다.
export const LOW_STOCK_MAX = 5;
const STOCK_FILTERS = { out: [0, 0], low: [1, LOW_STOCK_MAX] } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 상품 목록(keyset 커서 페이지). 정렬: 진열 순서 → 최근 등록 → id. nextCursor가 null이면 마지막 쪽이에요.
// 커서는 이 판매자 상품 id만 받고, 그 행의 정렬 값(sortOrder, createdAt, id) 바로 뒤부터 고른다.
// 기준 상품이 그사이 지워졌거나 필터 밖이 되어도 값만 쓰므로 다음 상품을 건너뛰지 않는다.
// limit은 숫자 또는 숫자만 있는 문자열(1~200)만 받는다("1e2", "0x10", " 5 "는 거부).
export async function listProducts(
  db: PrismaClient,
  ctx: TenantContext,
  opts: { status?: unknown; stock?: unknown; cursor?: unknown; limit?: unknown } = {},
): Promise<
  | { ok: true; value: { products: Awaited<ReturnType<typeof productView>>[]; nextCursor: string | null } }
  | { ok: false; reason: "invalid_cursor" | "invalid_limit" | "invalid_stock_filter" }
> {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const status = PRODUCT_STATUSES.includes(opts.status as ProductStatus) ? (opts.status as ProductStatus) : undefined;
  const limit =
    opts.limit === undefined ? DEFAULT_PAGE_SIZE : typeof opts.limit === "string" && /^\d+$/.test(opts.limit) ? Number(opts.limit) : typeof opts.limit === "number" ? opts.limit : NaN;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return { ok: false, reason: "invalid_limit" };
  let stockScope: Prisma.ProductWhereInput = {};
  if (opts.stock !== undefined && opts.stock !== "") {
    if (opts.stock !== "out" && opts.stock !== "low") return { ok: false, reason: "invalid_stock_filter" };
    const [lo, hi] = STOCK_FILTERS[opts.stock];
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT p."id" FROM "Product" p
      LEFT JOIN "ProductOption" o ON o."productId" = p."id" AND o."sellerId" = p."sellerId" AND o."deletedAt" IS NULL
      WHERE p."sellerId" = ${ctx.sellerId}::uuid AND p."deletedAt" IS NULL
      GROUP BY p."id"
      HAVING COALESCE(SUM(o."stock"), 0) BETWEEN ${lo} AND ${hi}`;
    stockScope = { id: { in: rows.map((r) => r.id) } };
  }
  let after: Prisma.ProductWhereInput = {};
  if (opts.cursor !== undefined && opts.cursor !== "") {
    if (typeof opts.cursor !== "string" || !UUID.test(opts.cursor)) return { ok: false, reason: "invalid_cursor" };
    const c = await db.product.findFirst({ where: { id: opts.cursor, sellerId: ctx.sellerId }, select: { id: true, sortOrder: true, createdAt: true } });
    if (!c) return { ok: false, reason: "invalid_cursor" };
    after = {
      OR: [
        { sortOrder: { gt: c.sortOrder } },
        { sortOrder: c.sortOrder, createdAt: { lt: c.createdAt } },
        { sortOrder: c.sortOrder, createdAt: c.createdAt, id: { gt: c.id } },
      ],
    };
  }
  const rows = await db.product.findMany({
    where: { sellerId: ctx.sellerId, deletedAt: null, ...(status ? { status } : {}), ...stockScope, ...after },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    include: { options: { where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] } },
  });
  const page = rows.slice(0, limit);
  return {
    ok: true,
    value: {
      products: page.map(({ deletedAt: _d, options, ...p }) => ({ ...p, options: options.map(({ deletedAt: _o, ...o }) => o) })),
      nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    },
  };
}

export async function getProduct(db: PrismaClient, ctx: TenantContext, productId: string) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const p = await db.product.findFirst({ where: { id: productId, sellerId: ctx.sellerId, deletedAt: null }, select: { id: true } });
  if (!p) throw notFound();
  return productView(db, ctx.sellerId, productId);
}

export async function createProduct(db: PrismaClient, ctx: TenantContext, raw: unknown): Promise<ProductResult<Awaited<ReturnType<typeof productView>>>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (!raw || typeof raw !== "object") return fail("invalid_product");
  const b = raw as Record<string, unknown>;
  const named = productName(b.name);
  if (!named.ok) return fail(named.reason);
  const name = named.name;
  const description = multiline(b.description, 5000);
  const status = b.status ?? "DRAFT";
  const sortOrder = b.sortOrder ?? 0;
  const stockDeductMode = b.stockDeductMode ?? "PAYMENT";
  if (
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

  return db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const product = await tx.product.create({
      data: { sellerId: ctx.sellerId, name, description, price, status: status as ProductStatus, sortOrder, stockDeductMode: stockDeductMode as StockDeductMode, createdAt: now },
    });
    for (const o of options) {
      const created = await tx.productOption.create({ data: { sellerId: ctx.sellerId, productId: product.id, ...o, createdAt: now } });
      if (o.stock > 0) await stockLog(tx, ctx, created.id, o.stock, now);
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
    if ((await tx.productOption.count({ where: { sellerId: ctx.sellerId, productId, deletedAt: null } })) >= MAX_OPTIONS_PER_PRODUCT) {
      return fail("too_many_options");
    }
    const now = await dbNow(tx);
    const last = await tx.productOption.aggregate({ where: { sellerId: ctx.sellerId, productId, deletedAt: null }, _max: { sortOrder: true } });
    const sortOrder = o.sortOrder ?? Math.min((last._max.sortOrder ?? -1) + 1, 100000);
    const option = await tx.productOption.create({ data: { sellerId: ctx.sellerId, productId, ...o, sortOrder, createdAt: now } });
    if (o.stock > 0) await stockLog(tx, ctx, option.id, o.stock, now);
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
    const now = await dbNow(tx);
    if (stockChange) {
      const stock = b.stock as number;
      const expectedStock = b.expectedStock as number;
      // 결제 차감과 겹치면 화면이 본 값과 달라지므로 덮어쓰지 않는다
      const moved = await tx.productOption.updateMany({ where: { id: optionId, sellerId: ctx.sellerId, stock: expectedStock }, data: { stock } });
      if (moved.count !== 1) return fail("stock_conflict");
      if (stock !== expectedStock) await stockLog(tx, ctx, optionId, stock - expectedStock, now);
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

function stockLog(tx: Tx, ctx: TenantContext, optionId: string, delta: number, now: Date) {
  return tx.stockMovement.create({
    data: { sellerId: ctx.sellerId, optionId, delta, reason: "MANUAL", actorType: ctx.actorType, actorId: ctx.actorId, createdAt: now },
  });
}
