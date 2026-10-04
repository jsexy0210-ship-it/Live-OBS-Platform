import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { shopOpen } from "../buyers/signup";
import { checkPng, imageVersion, type PngRejection } from "../shop-content/image";
import { deleteImage, getImage, putImage } from "../storage";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 상품 사진(PR-A, 2026-10-04 대표님 지시, PRODUCT_MANAGE). 상품당 10장, 첫 번째(sortOrder 0)가 대표 사진(썸네일).
// - 형식은 확장자·Content-Type이 아니라 바이트로 확인한다. 지금은 PNG만(쇼핑몰 이미지와 같은 검사기 checkPng: 구조·CRC·그림 데이터까지).
// - 장당 5MB, 가로·세로 100~4000px. 바이트는 공통 저장소(lib/server/storage)에, 형식·크기·해시는 ProductImage에 둔다.
// - 주소는 저장 방식과 상관없는 우리 경로: 파트너스 관리자 /api/seller/products/{상품}/images/{사진}, 구매자 /api/shop/{slug}/products/{상품}/images/{사진}.
//   ?v=해시 앞 12자가 붙어 사진이 바뀌면 주소도 바뀐다(1년 캐시).
// - 지운 상품의 사진은 올리거나 바꿀 수 없고, 구매자 주소는 보이는 상품(판매 중·품절)의 사진만 준다.
export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const PRODUCT_IMAGE_MIN_SIDE = 100;
export const PRODUCT_IMAGE_MAX_SIDE = 4000;
export const MAX_PRODUCT_IMAGES = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ProductImageRejection = PngRejection | "wrong_image_size" | "too_many_images";
export const PRODUCT_IMAGE_MESSAGES: Record<ProductImageRejection | "invalid_image_order", string> = {
  empty_file: "빈 파일은 올릴 수 없습니다",
  file_too_large: "사진은 한 장에 5MB까지 올릴 수 있습니다",
  unsupported_image: "PNG 파일만 올릴 수 있습니다",
  wrong_image_size: `사진 가로·세로는 ${PRODUCT_IMAGE_MIN_SIDE}~${PRODUCT_IMAGE_MAX_SIDE}px여야 합니다`,
  png_16bit: "8비트(일반) PNG로 저장해 주십시오. 16비트 PNG는 올릴 수 없습니다",
  png_too_large: "사진 데이터가 너무 큽니다. 8비트(일반) PNG로 저장하거나 크기를 줄여 주십시오",
  too_many_images: `사진은 상품 하나에 ${MAX_PRODUCT_IMAGES}장까지 올릴 수 있습니다`,
  invalid_image_order: "사진 목록이 바뀌었습니다. 새로 불러온 뒤 다시 정해 주십시오",
};

export type ProductImageView = { id: string; url: string; sortOrder: number; width: number; height: number };
type Row = { id: string; productId: string; sha256: string; sortOrder: number; width: number; height: number };
type Db = PrismaClient | Prisma.TransactionClient;

export const sellerImageUrl = (r: Pick<Row, "id" | "productId" | "sha256">) => `/api/seller/products/${r.productId}/images/${r.id}?v=${imageVersion(r.sha256)}`;
export const shopImageUrl = (slug: string, r: Pick<Row, "id" | "productId" | "sha256">) =>
  `/api/shop/${encodeURIComponent(slug)}/products/${r.productId}/images/${r.id}?v=${imageVersion(r.sha256)}`;
const view = (r: Row): ProductImageView => ({ id: r.id, url: sellerImageUrl(r), sortOrder: r.sortOrder, width: r.width, height: r.height });
const SELECT = { id: true, productId: true, sha256: true, sortOrder: true, width: true, height: true } as const;
const ORDER = [{ sortOrder: "asc" as const }, { createdAt: "asc" as const }, { id: "asc" as const }];

export function checkProductImage(b: Buffer) {
  return checkPng(b, PRODUCT_IMAGE_MAX_BYTES, (w, h) =>
    w >= PRODUCT_IMAGE_MIN_SIDE && w <= PRODUCT_IMAGE_MAX_SIDE && h >= PRODUCT_IMAGE_MIN_SIDE && h <= PRODUCT_IMAGE_MAX_SIDE ? null : ("wrong_image_size" as const),
  );
}

// 지우지 않은 이 판매자 상품을 잠근다(사진 개수·순서 판정이 동시 요청에 깨지지 않게). 없으면 404.
async function lockLiveProduct(tx: Prisma.TransactionClient, sellerId: string, productId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Product" WHERE "id" = ${productId}::uuid AND "sellerId" = ${sellerId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
  if (!rows[0]) throw notFound();
}

export async function listProductImages(db: Db, sellerId: string, productId: string): Promise<ProductImageView[]> {
  return (await db.productImage.findMany({ where: { sellerId, productId }, orderBy: ORDER, select: SELECT })).map(view);
}

// 상품 목록의 대표 사진 주소(상품 id → 주소). 사진이 없는 상품은 없음.
export async function thumbnailUrls(db: Db, sellerId: string, productIds: string[], slug?: string): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();
  const rows = await db.$queryRaw<Pick<Row, "id" | "productId" | "sha256">[]>`
    SELECT DISTINCT ON (i."productId") i."id", i."productId", i."sha256" FROM "ProductImage" i
    WHERE i."sellerId" = ${sellerId}::uuid AND i."productId" = ANY(${productIds}::uuid[])
    ORDER BY i."productId", i."sortOrder", i."createdAt", i."id"`;
  return new Map(rows.map((r) => [r.productId, slug === undefined ? sellerImageUrl(r) : shopImageUrl(slug, r)]));
}

export async function uploadProductImage(
  db: PrismaClient,
  ctx: TenantContext,
  productId: string,
  bytes: Buffer,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ ok: true; image: ProductImageView } | { ok: false; reason: ProductImageRejection }> {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const check = checkProductImage(bytes);
  if (!check.ok) return check;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return db.$transaction(async (tx) => {
    await lockLiveProduct(tx, ctx.sellerId, productId);
    const count = await tx.productImage.count({ where: { sellerId: ctx.sellerId, productId } });
    if (count >= MAX_PRODUCT_IMAGES) return { ok: false as const, reason: "too_many_images" as const };
    const last = await tx.productImage.aggregate({ where: { sellerId: ctx.sellerId, productId }, _max: { sortOrder: true } });
    const contentType = "image/png" as const;
    const storageKey = await putImage(tx, { sellerId: ctx.sellerId, bytes, contentType, sha256 });
    const row = await tx.productImage.create({
      data: {
        sellerId: ctx.sellerId,
        productId,
        storageKey,
        contentType,
        byteSize: bytes.length,
        width: check.width,
        height: check.height,
        sha256,
        sortOrder: (last._max.sortOrder ?? -1) + 1,
      },
      select: SELECT,
    });
    // 바이트 대신 형식·크기·해시만 남긴다
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product_image.upload",
      targetType: "ProductImage",
      targetId: row.id,
      after: { productId, contentType, width: check.width, height: check.height, byteSize: bytes.length, sha256 },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, image: view(row) };
  });
}

// 순서 바꾸기. 본문 { imageIds: [이 상품 사진 전부, 새 순서] }. 첫 번째가 대표 사진. 목록이 지금과 다르면 거부.
export async function reorderProductImages(db: PrismaClient, ctx: TenantContext, productId: string, raw: unknown) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const ids = Array.isArray(b.imageIds) && b.imageIds.every((v) => typeof v === "string" && UUID.test(v)) ? (b.imageIds as string[]).map((v) => v.toLowerCase()) : null;
  return db.$transaction(async (tx) => {
    await lockLiveProduct(tx, ctx.sellerId, productId);
    const current = await tx.productImage.findMany({ where: { sellerId: ctx.sellerId, productId }, select: { id: true } });
    if (!ids || new Set(ids).size !== ids.length || ids.length !== current.length || !current.every((c) => ids.includes(c.id))) {
      return { ok: false as const, reason: "invalid_image_order" as const };
    }
    for (const [i, id] of ids.entries()) await tx.productImage.update({ where: { id }, data: { sortOrder: i } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product_image.reorder",
      targetType: "Product",
      targetId: productId,
      after: { imageIds: ids },
    });
    return { ok: true as const, images: await listProductImages(tx, ctx.sellerId, productId) };
  });
}

// 사진 지우기(행과 저장소 바이트 모두). 남은 사진 순서를 0부터 다시 매긴다(첫 번째가 새 대표 사진).
export async function deleteProductImage(db: PrismaClient, ctx: TenantContext, productId: string, imageId: string) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  return db.$transaction(async (tx) => {
    await lockLiveProduct(tx, ctx.sellerId, productId);
    const row = await tx.productImage.findFirst({ where: { id: imageId, sellerId: ctx.sellerId, productId }, select: { storageKey: true, sha256: true } });
    if (!row) throw notFound();
    await tx.productImage.delete({ where: { id: imageId } });
    await deleteImage(tx, row.storageKey, ctx.sellerId);
    const rest = await tx.productImage.findMany({ where: { sellerId: ctx.sellerId, productId }, orderBy: ORDER, select: { id: true } });
    for (const [i, r] of rest.entries()) await tx.productImage.update({ where: { id: r.id }, data: { sortOrder: i } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product_image.delete",
      targetType: "ProductImage",
      targetId: imageId,
      before: { productId, sha256: row.sha256 },
    });
    return { images: await listProductImages(tx, ctx.sellerId, productId) };
  });
}

// 파트너스 관리자 미리보기용 바이트(지운 상품 사진은 404)
export async function sellerProductImage(db: PrismaClient, ctx: TenantContext, productId: string, imageId: string) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  const row = await db.productImage.findFirst({
    where: { id: imageId, sellerId: ctx.sellerId, productId, product: { deletedAt: null } },
    select: { storageKey: true },
  });
  return row ? getImage(db, row.storageKey, ctx.sellerId) : null;
}

// 구매자 쇼핑몰 사진. 운영 중인 쇼핑몰의 보이는 상품(판매 중·품절, 지우지 않음) 사진만. 아니면 null(404).
export async function publicProductImage(db: PrismaClient, slug: string, productId: string, imageId: string) {
  const shop = await db.seller.findUnique({ where: { slug }, select: { id: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  const row = await db.productImage.findFirst({
    where: { id: imageId, sellerId: shop.id, productId, product: { deletedAt: null, status: { in: ["ON_SALE", "SOLD_OUT"] } } },
    select: { storageKey: true },
  });
  return row ? getImage(db, row.storageKey, shop.id) : null;
}
