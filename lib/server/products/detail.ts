import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { cleanText } from "../text/clean";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { listProductImages, sellerImageUrl, shopImageUrl } from "./images";

// 상품 상세 페이지(PR-B, 2026-10-04 대표님 지시, PRODUCT_MANAGE). 카페24처럼 글·사진 블록을 순서대로 둔다.
// HTML·링크·스타일은 받지 않고 블록 구조로만 저장한다(화면은 글을 글자 그대로 그린다).
// - 글 블록 { type: "text", text }: 줄바꿈만 허용하는 글자 1~2000자(cleanText multiline).
// - 사진 블록 { type: "image", imageId }: 이 상품의 상세 사진(kind DETAIL, 업로드 ?kind=detail)만. 같은 사진을 여러 번 써도 된다.
// - 최대 30블록. 저장은 통째로 바꾼다. 상세 사진을 지우면 그 사진 블록도 빠진다(images.ts).
export const DETAIL_MAX_BLOCKS = 30;
export const DETAIL_TEXT_MAX = 2000;

type StoredBlock = { type: "text"; text: string } | { type: "image"; imageId: string };
export type DetailBlockView = { type: "text"; text: string } | { type: "image"; imageId: string; url: string; width: number; height: number };
type Db = PrismaClient | Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseBlocks(raw: unknown): StoredBlock[] | null {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>).blocks : undefined;
  if (!Array.isArray(b) || b.length > DETAIL_MAX_BLOCKS) return null;
  const out: StoredBlock[] = [];
  for (const item of b) {
    if (!item || typeof item !== "object") return null;
    const { type, text, imageId, ...rest } = item as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return null;
    if (type === "text" && imageId === undefined) {
      const t = cleanText(text, DETAIL_TEXT_MAX, "multiline");
      if (!t) return null;
      out.push({ type: "text", text: t });
    } else if (type === "image" && text === undefined && typeof imageId === "string" && UUID.test(imageId)) {
      out.push({ type: "image", imageId: imageId.toLowerCase() });
    } else {
      return null;
    }
  }
  return out;
}

async function blocksView(db: Db, sellerId: string, productId: string, slug?: string): Promise<DetailBlockView[]> {
  const row = await db.productDetail.findFirst({ where: { sellerId, productId }, select: { blocks: true } });
  const blocks = (Array.isArray(row?.blocks) ? row.blocks : []) as StoredBlock[];
  const images = await db.productImage.findMany({ where: { sellerId, productId, kind: "DETAIL" }, select: { id: true, productId: true, sha256: true, width: true, height: true } });
  const byId = new Map(images.map((i) => [i.id, i]));
  return blocks.flatMap((b): DetailBlockView[] => {
    if (b.type === "text") return [{ type: "text", text: b.text }];
    const img = byId.get(b.imageId);
    if (!img) return [];
    return [{ type: "image", imageId: img.id, url: slug === undefined ? sellerImageUrl(img) : shopImageUrl(slug, img), width: img.width, height: img.height }];
  });
}

// 파트너스 관리자: { blocks, images(올려 둔 상세 사진 전부) }
export async function getProductDetail(db: PrismaClient, ctx: TenantContext, productId: string) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  if (!(await db.product.findFirst({ where: { id: productId, sellerId: ctx.sellerId, deletedAt: null }, select: { id: true } }))) throw notFound();
  return { blocks: await blocksView(db, ctx.sellerId, productId), images: await listProductImages(db, ctx.sellerId, productId, "DETAIL") };
}

export async function setProductDetail(db: PrismaClient, ctx: TenantContext, productId: string, raw: unknown) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const blocks = parseBlocks(raw);
  if (!blocks) return { ok: false as const, reason: "invalid_detail" as const };
  return db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "Product" WHERE "id" = ${productId}::uuid AND "sellerId" = ${ctx.sellerId}::uuid AND "deletedAt" IS NULL FOR UPDATE`;
    if (!locked[0]) throw notFound();
    // 사진 블록은 이 상품의 상세 사진만(다른 상품·다른 판매자·대표 사진이면 저장하지 않음)
    const ids = [...new Set(blocks.flatMap((b) => (b.type === "image" ? [b.imageId] : [])))];
    if (ids.length && (await tx.productImage.count({ where: { id: { in: ids }, sellerId: ctx.sellerId, productId, kind: "DETAIL" } })) !== ids.length) {
      return { ok: false as const, reason: "invalid_detail" as const };
    }
    await tx.productDetail.upsert({
      where: { productId },
      create: { productId, sellerId: ctx.sellerId, blocks },
      update: { blocks },
    });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "product.detail",
      targetType: "Product",
      targetId: productId,
      after: { blocks: blocks.length, images: ids.length },
    });
    return { ok: true as const, value: { blocks: await blocksView(tx, ctx.sellerId, productId), images: await listProductImages(tx, ctx.sellerId, productId, "DETAIL") } };
  });
}

// 구매자 상품 상세용 블록(사진 주소는 구매자 공개 주소). 보이는 상품인지는 부르는 쪽이 확인한다.
export const publicDetailBlocks = (db: Db, sellerId: string, slug: string, productId: string) => blocksView(db, sellerId, productId, slug);
