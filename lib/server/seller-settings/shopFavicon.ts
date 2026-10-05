import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { writeAudit } from "../audit/log";
import { shopOpen } from "../buyers/signup";
import { FAVICON_SIZES, isFaviconSize, renderFaviconPng, type FaviconSize } from "../shop/faviconRender";
import { checkPng, type PngRejection } from "../shop-content/image";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 쇼핑몰 파비콘(SA-060, docs/IA.md SA-060). 올린 PNG가 있으면 그것을, 없으면 로고에서 자동으로(가운데 맞춤·여백, 32·180·512px PNG), 로고도 없으면 없음(화면이 ONQ 기본 아이콘).
// - 올리기: 8비트 PNG만, 256KB 이하, 정사각형 64~1024px(파일 내용으로 확인). 보기는 같은 쇼핑몰 계정 누구나(SHOP_SETTINGS 읽기), 바꾸기·지우기는 대표자·SHOP_SETTINGS 직원만. 로그 추적에 크기·해시만 남긴다.
// - 구매자 화면용 주소: /api/shop/{slug}/favicon/{32|180|512}?v=버전(로그인 없이, 운영 중인 쇼핑몰만).
export const FAVICON_MAX_BYTES = 256 * 1024;
export const FAVICON_MIN_SIDE = 64;
export const FAVICON_MAX_SIDE = 1024;
const LOGO_INSET = 0.1;

export type FaviconRejection = PngRejection | "not_square" | "wrong_image_size";

export const FAVICON_MESSAGES: Record<FaviconRejection, string> = {
  empty_file: "빈 파일은 올릴 수 없습니다",
  file_too_large: "파비콘은 256KB까지 올릴 수 있습니다",
  unsupported_image: "PNG 파일만 올릴 수 있습니다",
  not_square: "파비콘은 가로와 세로가 같은 정사각형이어야 합니다",
  wrong_image_size: `파비콘은 ${FAVICON_MIN_SIDE}~${FAVICON_MAX_SIDE}px 정사각형이어야 합니다`,
  png_16bit: "8비트(일반) PNG로 저장해 주십시오. 16비트 PNG는 올릴 수 없습니다",
  png_too_large: "이미지 데이터가 너무 큽니다. 8비트(일반) PNG로 저장하거나 크기를 줄여 주십시오",
};

export function checkFavicon(b: Buffer): { ok: true; width: number } | { ok: false; reason: FaviconRejection } {
  const r = checkPng(b, FAVICON_MAX_BYTES, (w, h): "not_square" | "wrong_image_size" | null => (w !== h ? "not_square" : w < FAVICON_MIN_SIDE || w > FAVICON_MAX_SIDE ? "wrong_image_size" : null));
  return r.ok ? { ok: true, width: r.width } : r;
}

export type FaviconSource = "UPLOADED" | "LOGO";
// 주소 버전: 원본 종류와 해시로 만든다(같은 바이트라도 종류가 다르면 그림이 달라 주소도 다르다)
const versionOf = (source: FaviconSource, sha256: string) => createHash("sha256").update(`favicon-v1\0${source}\0${sha256}`).digest("hex").slice(0, 12);
export const faviconPath = (slug: string, size: FaviconSize, version: string) => `/api/shop/${encodeURIComponent(slug)}/favicon/${size}?v=${version}`;

export type ShopFaviconView = {
  source: FaviconSource | null;
  version: string | null;
  sizes: readonly FaviconSize[];
  urls: Record<FaviconSize, string> | null;
  uploaded: { width: number; byteSize: number } | null;
};

type Db = PrismaClient | Prisma.TransactionClient;

async function resolveSource(db: Db, sellerId: string) {
  const f = await db.sellerFavicon.findUnique({ where: { sellerId }, select: { sha256: true, width: true, byteSize: true } });
  if (f) return { source: "UPLOADED" as const, sha256: f.sha256, uploaded: { width: f.width, byteSize: f.byteSize } };
  const l = await db.sellerLogo.findUnique({ where: { sellerId }, select: { sha256: true } });
  if (l) return { source: "LOGO" as const, sha256: l.sha256, uploaded: null };
  return { source: null, sha256: null, uploaded: null };
}

export async function viewFavicon(db: Db, sellerId: string, slug: string): Promise<ShopFaviconView> {
  const r = await resolveSource(db, sellerId);
  if (!r.source) return { source: null, version: null, sizes: FAVICON_SIZES, urls: null, uploaded: null };
  const version = versionOf(r.source, r.sha256);
  const urls = Object.fromEntries(FAVICON_SIZES.map((s) => [s, faviconPath(slug, s, version)])) as Record<FaviconSize, string>;
  return { source: r.source, version, sizes: FAVICON_SIZES, urls, uploaded: r.uploaded };
}

async function slugOf(db: Db, sellerId: string) {
  return (await db.seller.findUniqueOrThrow({ where: { id: sellerId }, select: { slug: true } })).slug;
}

export async function readShopFavicon(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  return viewFavicon(db, ctx.sellerId, await slugOf(db, ctx.sellerId));
}

type Meta = { ip?: string | null; userAgent?: string | null };
const lockShop = (tx: Prisma.TransactionClient, sellerId: string) => tx.$queryRaw`SELECT 1 FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR NO KEY UPDATE`;

export async function putShopFavicon(db: PrismaClient, ctx: TenantContext, bytes: Buffer, meta: Meta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const check = checkFavicon(bytes);
  if (!check.ok) return check;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const data = { data: new Uint8Array(bytes), byteSize: bytes.length, width: check.width, sha256 };
  return db.$transaction(async (tx) => {
    await lockShop(tx, ctx.sellerId);
    const before = await tx.sellerFavicon.findUnique({ where: { sellerId: ctx.sellerId }, select: { width: true, byteSize: true, sha256: true } });
    await tx.sellerFavicon.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: data });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop.favicon.update",
      targetType: "SellerFavicon",
      targetId: ctx.sellerId,
      before: before ?? undefined,
      after: { width: check.width, byteSize: bytes.length, sha256 },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, favicon: await viewFavicon(tx, ctx.sellerId, await slugOf(tx, ctx.sellerId)) };
  });
}

// 지우면 로고에서 자동으로 만든 아이콘(없으면 기본 아이콘)으로 돌아간다. 없는 파비콘을 지워도 성공, 로그는 실제로 지웠을 때만.
export async function deleteShopFavicon(db: PrismaClient, ctx: TenantContext, meta: Meta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  return db.$transaction(async (tx) => {
    await lockShop(tx, ctx.sellerId);
    const before = await tx.sellerFavicon.findUnique({ where: { sellerId: ctx.sellerId }, select: { width: true, byteSize: true, sha256: true } });
    if (before) {
      await tx.sellerFavicon.delete({ where: { sellerId: ctx.sellerId } });
      await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "shop.favicon.delete", targetType: "SellerFavicon", targetId: ctx.sellerId, before, ip: meta.ip, userAgent: meta.userAgent });
    }
    return { ok: true as const, favicon: await viewFavicon(tx, ctx.sellerId, await slugOf(tx, ctx.sellerId)) };
  });
}

// 구매자 화면용 PNG. 운영 중이고 잠기지 않은 쇼핑몰만, 올린 파비콘 → 로고 순서. 없으면 null.
export async function publicFavicon(db: PrismaClient, slug: string, size: FaviconSize) {
  const shop = await db.seller.findUnique({ where: { slug }, select: { id: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  const f = await db.sellerFavicon.findUnique({ where: { sellerId: shop.id }, select: { data: true, sha256: true } });
  const l = f ? null : await db.sellerLogo.findUnique({ where: { sellerId: shop.id }, select: { data: true, sha256: true } });
  const src = f ? { source: "UPLOADED" as const, ...f, inset: 0 } : l ? { source: "LOGO" as const, ...l, inset: LOGO_INSET } : null;
  if (!src) return null;
  const version = versionOf(src.source, src.sha256);
  return { png: await renderFaviconPng(`${src.source}:${src.sha256}`, src.data, size, src.inset), version };
}

export { isFaviconSize };
