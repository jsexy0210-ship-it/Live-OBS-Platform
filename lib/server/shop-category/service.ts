import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { shopOpen } from "../buyers/signup";
import { productCode } from "../products/manage";
import { thumbnailUrls } from "../products/images";
import { cleanText } from "../text/clean";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 쇼핑몰 카테고리(SA-015, PRODUCT_MANAGE). 2단까지: 대분류(parentId 없음) 아래 소분류만 둔다. 만든 뒤 부모는 바꾸지 않는다.
// - 이름: 한 줄 글자 1~30자(cleanText). 같은 부모 안 이름 중복은 막지 않는다(카페24와 같음).
// - 순서: 같은 부모 안에서 sortOrder(0부터). 새 카테고리는 맨 뒤. 순서 바꾸기는 그 부모의 카테고리 전부를 새 순서로 보내야 한다.
// - 노출(visible): 끄면 구매자 쇼핑몰에 보이지 않는다. 대분류를 끄면 그 아래 소분류도 보이지 않는다.
// - 삭제: 소분류가 남은 대분류는 지우지 않는다(category_has_children). 지우면 상품 연결도 지워진다(상품은 그대로).
// - 다른 판매자 카테고리·상품은 없는 것(404)으로 본다. 변경은 판매자별 잠금으로 줄을 세워 개수 한도·순서가 겹치지 않게 한다.
export const CATEGORY_NAME_MAX = 30;
export const MAX_CATEGORIES = 300;
export const MAX_CATEGORIES_PER_PRODUCT = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CategoryFailure =
  | "invalid_category"
  | "too_many_categories"
  | "category_has_children"
  | "invalid_category_order"
  | "too_many_product_categories";
export type CategoryResult<T> = { ok: true; value: T } | { ok: false; reason: CategoryFailure };
const fail = (reason: CategoryFailure) => ({ ok: false as const, reason });
type Tx = Prisma.TransactionClient;

const lockSellerCategories = (tx: Tx, sellerId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop_category:${sellerId}`}))`;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export type CategoryNode = { id: string; name: string; visible: boolean; sortOrder: number; productCount: number; children: Omit<CategoryNode, "children">[] };

// 판매자 화면용 트리. productCount는 지우지 않은 상품 수(상태 무관, 그 카테고리에 직접 지정한 것만).
export async function listCategories(db: PrismaClient | Tx, ctx: TenantContext): Promise<CategoryNode[]> {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const rows = await db.shopCategory.findMany({
    where: { sellerId: ctx.sellerId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, parentId: true, name: true, visible: true, sortOrder: true },
  });
  const counts = await db.productCategory.groupBy({
    by: ["categoryId"],
    where: { sellerId: ctx.sellerId, product: { deletedAt: null } },
    _count: { _all: true },
  });
  const countBy = new Map(counts.map((c) => [c.categoryId, c._count._all]));
  const node = (r: (typeof rows)[number]) => ({ id: r.id, name: r.name, visible: r.visible, sortOrder: r.sortOrder, productCount: countBy.get(r.id) ?? 0 });
  return rows.filter((r) => !r.parentId).map((p) => ({ ...node(p), children: rows.filter((c) => c.parentId === p.id).map(node) }));
}

export async function createCategory(db: PrismaClient, ctx: TenantContext, raw: unknown): Promise<CategoryResult<CategoryNode[]>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (!raw || typeof raw !== "object") return fail("invalid_category");
  const b = raw as Record<string, unknown>;
  const name = cleanText(b.name, CATEGORY_NAME_MAX);
  const parentId = b.parentId ?? null;
  const visible = b.visible ?? true;
  if (!name || (parentId !== null && !isUuid(parentId)) || typeof visible !== "boolean") return fail("invalid_category");
  return db.$transaction(async (tx) => {
    await lockSellerCategories(tx, ctx.sellerId);
    if (parentId) {
      const parent = await tx.shopCategory.findFirst({ where: { id: parentId, sellerId: ctx.sellerId }, select: { parentId: true } });
      if (!parent) throw notFound();
      // 소분류 아래에는 만들 수 없다(2단까지)
      if (parent.parentId) return fail("invalid_category");
    }
    if ((await tx.shopCategory.count({ where: { sellerId: ctx.sellerId } })) >= MAX_CATEGORIES) return fail("too_many_categories");
    const last = await tx.shopCategory.aggregate({ where: { sellerId: ctx.sellerId, parentId }, _max: { sortOrder: true } });
    const created = await tx.shopCategory.create({ data: { sellerId: ctx.sellerId, parentId, name, visible, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop_category.create",
      targetType: "ShopCategory",
      targetId: created.id,
      after: { name, parentId, visible },
    });
    return { ok: true as const, value: await listCategories(tx, ctx) };
  });
}

// 본문: 바꿀 항목만 { name?, visible? }
export async function updateCategory(db: PrismaClient, ctx: TenantContext, categoryId: string, raw: unknown): Promise<CategoryResult<CategoryNode[]>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (!raw || typeof raw !== "object") return fail("invalid_category");
  const b = raw as Record<string, unknown>;
  const data: { name?: string; visible?: boolean } = {};
  if (b.name !== undefined) {
    const name = cleanText(b.name, CATEGORY_NAME_MAX);
    if (!name) return fail("invalid_category");
    data.name = name;
  }
  if (b.visible !== undefined) {
    if (typeof b.visible !== "boolean") return fail("invalid_category");
    data.visible = b.visible;
  }
  if (Object.keys(data).length === 0) return fail("invalid_category");
  return db.$transaction(async (tx) => {
    await lockSellerCategories(tx, ctx.sellerId);
    const before = await tx.shopCategory.findFirst({ where: { id: categoryId, sellerId: ctx.sellerId }, select: { name: true, visible: true } });
    if (!before) throw notFound();
    await tx.shopCategory.update({ where: { id: categoryId }, data });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop_category.update",
      targetType: "ShopCategory",
      targetId: categoryId,
      before,
      after: data,
    });
    return { ok: true as const, value: await listCategories(tx, ctx) };
  });
}

export async function deleteCategory(db: PrismaClient, ctx: TenantContext, categoryId: string): Promise<CategoryResult<CategoryNode[]>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  return db.$transaction(async (tx) => {
    await lockSellerCategories(tx, ctx.sellerId);
    const row = await tx.shopCategory.findFirst({ where: { id: categoryId, sellerId: ctx.sellerId }, select: { name: true, parentId: true } });
    if (!row) throw notFound();
    if ((await tx.shopCategory.count({ where: { sellerId: ctx.sellerId, parentId: categoryId } })) > 0) return fail("category_has_children");
    const links = await tx.productCategory.count({ where: { sellerId: ctx.sellerId, categoryId } });
    await tx.shopCategory.delete({ where: { id: categoryId } });
    // 남은 형제 순서를 0부터 다시 매긴다
    const siblings = await tx.shopCategory.findMany({
      where: { sellerId: ctx.sellerId, parentId: row.parentId },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    for (const [i, s] of siblings.entries()) await tx.shopCategory.update({ where: { id: s.id }, data: { sortOrder: i } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop_category.delete",
      targetType: "ShopCategory",
      targetId: categoryId,
      before: { name: row.name, parentId: row.parentId, productLinks: links },
    });
    return { ok: true as const, value: await listCategories(tx, ctx) };
  });
}

// 본문: { parentId: null | 대분류 id, categoryIds: [그 부모의 카테고리 전부, 새 순서대로] }
export async function reorderCategories(db: PrismaClient, ctx: TenantContext, raw: unknown): Promise<CategoryResult<CategoryNode[]>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  if (!raw || typeof raw !== "object") return fail("invalid_category_order");
  const b = raw as Record<string, unknown>;
  const parentId = b.parentId ?? null;
  if ((parentId !== null && !isUuid(parentId)) || !Array.isArray(b.categoryIds) || !b.categoryIds.every(isUuid)) return fail("invalid_category_order");
  const ids = (b.categoryIds as string[]).map((id) => id.toLowerCase());
  if (new Set(ids).size !== ids.length) return fail("invalid_category_order");
  return db.$transaction(async (tx) => {
    await lockSellerCategories(tx, ctx.sellerId);
    if (parentId && !(await tx.shopCategory.findFirst({ where: { id: parentId, sellerId: ctx.sellerId }, select: { id: true } }))) throw notFound();
    const siblings = await tx.shopCategory.findMany({ where: { sellerId: ctx.sellerId, parentId }, select: { id: true } });
    // 그사이 추가·삭제된 카테고리가 있으면 화면이 본 목록과 달라지므로 받지 않는다
    if (siblings.length !== ids.length || !siblings.every((s) => ids.includes(s.id))) return fail("invalid_category_order");
    for (const [i, id] of ids.entries()) await tx.shopCategory.update({ where: { id }, data: { sortOrder: i } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop_category.reorder",
      targetType: "ShopCategory",
      targetId: parentId ?? ctx.sellerId,
      after: { parentId, categoryIds: ids },
    });
    return { ok: true as const, value: await listCategories(tx, ctx) };
  });
}

async function liveProduct(db: PrismaClient | Tx, sellerId: string, productId: string, lock: boolean) {
  const rows = lock
    ? await db.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Product" WHERE "id" = ${productId}::uuid AND "sellerId" = ${sellerId}::uuid AND "deletedAt" IS NULL FOR UPDATE`
    : await db.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Product" WHERE "id" = ${productId}::uuid AND "sellerId" = ${sellerId}::uuid AND "deletedAt" IS NULL`;
  if (!rows[0]) throw notFound();
}

// 상품에 지정한 카테고리 id(대분류 순서 → 소분류 순서)
export async function productCategoryIds(db: PrismaClient | Tx, ctx: TenantContext, productId: string): Promise<string[]> {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  await liveProduct(db, ctx.sellerId, productId, false);
  const links = await db.productCategory.findMany({
    where: { sellerId: ctx.sellerId, productId },
    select: { category: { select: { id: true, sortOrder: true, parent: { select: { sortOrder: true } } } } },
  });
  const key = (c: (typeof links)[number]["category"]) => [c.parent?.sortOrder ?? c.sortOrder, c.parent ? c.sortOrder : -1];
  return links
    .map((l) => l.category)
    .sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1] || (a.id < b.id ? -1 : 1))
    .map((c) => c.id);
}

// 본문: { categoryIds: [...] }(0~10개, 빈 배열이면 전부 해제). 지정 목록을 통째로 바꾼다.
export async function setProductCategories(db: PrismaClient, ctx: TenantContext, productId: string, raw: unknown): Promise<CategoryResult<string[]>> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (!Array.isArray(b.categoryIds) || !b.categoryIds.every(isUuid)) return fail("invalid_category");
  const ids = [...new Set((b.categoryIds as string[]).map((id) => id.toLowerCase()))];
  if (ids.length > MAX_CATEGORIES_PER_PRODUCT) return fail("too_many_product_categories");
  return db.$transaction(async (tx) => {
    await lockSellerCategories(tx, ctx.sellerId);
    await liveProduct(tx, ctx.sellerId, productId, true);
    // 다른 판매자 카테고리·없는 카테고리가 섞이면 하나도 바꾸지 않는다
    if ((await tx.shopCategory.count({ where: { sellerId: ctx.sellerId, id: { in: ids } } })) !== ids.length) return fail("invalid_category");
    const before = (await tx.productCategory.findMany({ where: { sellerId: ctx.sellerId, productId }, select: { categoryId: true } })).map((r) => r.categoryId);
    await tx.productCategory.deleteMany({ where: { sellerId: ctx.sellerId, productId, categoryId: { notIn: ids } } });
    // 새로 지정한 카테고리에서는 맨 뒤(카테고리 안 진열 순서)
    for (const categoryId of ids.filter((id) => !before.includes(id))) {
      const last = await tx.productCategory.aggregate({ where: { sellerId: ctx.sellerId, categoryId }, _max: { sortOrder: true } });
      await tx.productCategory.create({ data: { sellerId: ctx.sellerId, productId, categoryId, sortOrder: (last._max.sortOrder ?? -1) + 1 } });
    }
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product.categories",
      targetType: "Product",
      targetId: productId,
      before: { categoryIds: before },
      after: { categoryIds: ids },
    });
    return { ok: true as const, value: await productCategoryIds(tx, ctx, productId) };
  });
}

export type PublicCategory = { id: string; name: string; children: { id: string; name: string }[] };

// 구매자 쇼핑몰 카테고리(로그인 없이). 보이는 대분류와 그 아래 보이는 소분류만, 순서대로. 운영 중이 아닌 쇼핑몰은 null(404).
export async function publicCategories(db: PrismaClient, slug: string): Promise<PublicCategory[] | null> {
  const shop = await db.seller.findUnique({ where: { slug }, select: { id: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  const rows = await db.shopCategory.findMany({
    where: { sellerId: shop.id, visible: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    select: { id: true, parentId: true, name: true },
  });
  return rows
    .filter((r) => !r.parentId)
    .map((p) => ({ id: p.id, name: p.name, children: rows.filter((c) => c.parentId === p.id).map(({ id, name }) => ({ id, name })) }));
}

// 카테고리 안 진열 순서(SA-016). 이 카테고리에 직접 지정한 지우지 않은 상품, 순서대로.
export async function listCategoryProducts(db: PrismaClient, ctx: TenantContext, categoryId: string) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  if (!(await db.shopCategory.findFirst({ where: { id: categoryId, sellerId: ctx.sellerId }, select: { id: true } }))) throw notFound();
  return categoryProducts(db, ctx.sellerId, categoryId);
}

async function categoryProducts(db: PrismaClient | Tx, sellerId: string, categoryId: string) {
  const links = await db.productCategory.findMany({
    where: { sellerId, categoryId, product: { deletedAt: null } },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { productId: "asc" }],
    select: { productId: true, product: { select: { codeNo: true, name: true, status: true } } },
  });
  const thumbs = await thumbnailUrls(db, sellerId, links.map((l) => l.productId));
  return links.map((l, i) => ({
    productId: l.productId,
    code: productCode(l.product.codeNo),
    name: l.product.name,
    status: l.product.status,
    sortOrder: i,
    thumbnailUrl: thumbs.get(l.productId) ?? null,
  }));
}

// 본문 { productIds: [이 카테고리에 지정한 지우지 않은 상품 전부, 새 순서] }. 목록이 지금과 다르면 거부(invalid_category_order).
export async function reorderCategoryProducts(db: PrismaClient, ctx: TenantContext, categoryId: string, raw: unknown) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ids = Array.isArray(b.productIds) && b.productIds.every(isUuid) ? (b.productIds as string[]).map((v) => v.toLowerCase()) : null;
  return db.$transaction(async (tx) => {
    await lockSellerCategories(tx, ctx.sellerId);
    if (!(await tx.shopCategory.findFirst({ where: { id: categoryId, sellerId: ctx.sellerId }, select: { id: true } }))) throw notFound();
    const current = await tx.productCategory.findMany({ where: { sellerId: ctx.sellerId, categoryId, product: { deletedAt: null } }, select: { productId: true } });
    if (!ids || new Set(ids).size !== ids.length || ids.length !== current.length || !current.every((c) => ids.includes(c.productId))) {
      return fail("invalid_category_order");
    }
    for (const [i, productId] of ids.entries()) {
      await tx.productCategory.update({ where: { productId_categoryId: { productId, categoryId } }, data: { sortOrder: i } });
    }
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop_category.product_order",
      targetType: "ShopCategory",
      targetId: categoryId,
      after: { productIds: ids },
    });
    return { ok: true as const, value: await categoryProducts(tx, ctx.sellerId, categoryId) };
  });
}
