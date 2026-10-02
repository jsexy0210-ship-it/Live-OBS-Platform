import type { Prisma, PrismaClient, ProductStatus } from "@prisma/client";
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

export type ProductFailure = "invalid_product" | "invalid_option" | "invalid_price" | "too_many_options" | "no_sellable_option" | "stock_conflict";
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

type OptionInput = { name: string; priceDelta: number; stock: number; sku: string | null; sortOrder: number };

function parseNewOption(raw: unknown): OptionInput | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const name = line(b.name, 100);
  const priceDelta = b.priceDelta ?? 0;
  const stock = b.stock ?? 0;
  const sortOrder = b.sortOrder ?? 0;
  const noSku = b.sku === undefined || b.sku === null || b.sku === "";
  const sku = noSku ? null : line(b.sku, 64);
  if (!name || (!noSku && sku === null)) return null;
  if (!isInt(priceDelta, -INT4_MAX, INT4_MAX) || !isInt(stock, 0, INT4_MAX) || !isInt(sortOrder, -100000, 100000)) return null;
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
  tx.productOption.findMany({ where: { sellerId, productId, deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] });

async function productView(tx: Tx | PrismaClient, sellerId: string, productId: string) {
  const p = await tx.product.findFirstOrThrow({ where: { id: productId, sellerId } });
  const { deletedAt: _d, ...rest } = p;
  return { ...rest, options: (await liveOptions(tx, sellerId, productId)).map(({ deletedAt: _o, ...o }) => o) };
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 상품 목록(커서 페이지). 정렬: 진열 순서 → 최근 등록 → id. nextCursor가 null이면 마지막 쪽이에요.
// 커서는 이 판매자 상품 id만 받는다(지운 상품이어도 위치 기준으로는 쓸 수 있음).
export async function listProducts(
  db: PrismaClient,
  ctx: TenantContext,
  opts: { status?: unknown; cursor?: unknown; limit?: unknown } = {},
): Promise<{ ok: true; value: { products: Awaited<ReturnType<typeof productView>>[]; nextCursor: string | null } } | { ok: false; reason: "invalid_cursor" }> {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const status = PRODUCT_STATUSES.includes(opts.status as ProductStatus) ? (opts.status as ProductStatus) : undefined;
  const limit = opts.limit === undefined ? DEFAULT_PAGE_SIZE : Number(opts.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) return { ok: false, reason: "invalid_cursor" };
  let cursor: string | undefined;
  if (opts.cursor !== undefined && opts.cursor !== "") {
    if (typeof opts.cursor !== "string" || !UUID.test(opts.cursor)) return { ok: false, reason: "invalid_cursor" };
    if (!(await db.product.findFirst({ where: { id: opts.cursor, sellerId: ctx.sellerId }, select: { id: true } }))) return { ok: false, reason: "invalid_cursor" };
    cursor = opts.cursor;
  }
  const rows = await db.product.findMany({
    where: { sellerId: ctx.sellerId, deletedAt: null, ...(status ? { status } : {}) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { options: { where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
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
  const name = line(b.name, 100);
  const description = multiline(b.description, 5000);
  const status = b.status ?? "DRAFT";
  const sortOrder = b.sortOrder ?? 0;
  if (!name || description === undefined || !PRODUCT_STATUSES.includes(status as ProductStatus) || !isInt(sortOrder, -100000, 100000)) {
    return fail("invalid_product");
  }
  if (!isInt(b.price, 1, INT4_MAX)) return fail("invalid_price");
  const price = b.price;
  const rawOptions = b.options ?? [];
  if (!Array.isArray(rawOptions)) return fail("invalid_option");
  if (rawOptions.length > MAX_OPTIONS_PER_PRODUCT) return fail("too_many_options");
  const options: OptionInput[] = [];
  for (const r of rawOptions) {
    const o = parseNewOption(r);
    if (!o) return fail("invalid_option");
    if (!unitOk(price, o.priceDelta)) return fail("invalid_price");
    options.push(o);
  }
  if (status === "ON_SALE" && options.length === 0) return fail("no_sellable_option");

  return db.$transaction(async (tx) => {
    const now = await dbNow(tx);
    const product = await tx.product.create({
      data: { sellerId: ctx.sellerId, name, description, price, status: status as ProductStatus, sortOrder, createdAt: now },
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
    const name = line(b.name, 100);
    if (!name) return fail("invalid_product");
    data.name = name;
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
    const option = await tx.productOption.create({ data: { sellerId: ctx.sellerId, productId, ...o, createdAt: now } });
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
