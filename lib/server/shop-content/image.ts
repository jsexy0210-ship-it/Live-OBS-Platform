import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { detectImage } from "../branding/image";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 배너·팝업 이미지. PNG만 받는다(2026-10-04 MASTER 결정: 서버가 내용까지 확인할 수 있는 형식만).
// 형식은 확장자·Content-Type이 아니라 바이트로 확인한다. 브랜딩 검사기 detectImage를 그대로 쓰며, PNG는 구조·CRC를 보고
// 그림 데이터를 실제로 풀어 길이·줄 필터까지 확인한다. JPEG·ICO·SVG·WebP·GIF는 받지 않는다.
// 저장은 대표님 저장 방식 결정 전까지 A안(DB bytea). 크기·형식 CHECK는 마이그레이션 20261004160000_shop_content와 같은 값.
export const SHOP_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const SHOP_IMAGE_MIN_SIDE = 100;
export const SHOP_IMAGE_MAX_SIDE = 2000;
// 전체 화소 수 상한 = 1920×1080(MASTER 결정 2026-10-04: PC 배너 표준 크기는 받는다). 브랜딩 검사기가 풀어 보는 그림 데이터
// 상한(8,400,000바이트) 안에 8비트 RGBA가 들어가는 값이다(2,073,600 × 4 + 줄 머리 1,080 = 8,295,480바이트).
export const SHOP_IMAGE_MAX_PIXELS = 1920 * 1080;
// 아직 배너·팝업에 쓰지 않은 이미지는 쇼핑몰당 이 개수까지만 둔다(올리기만 반복해 DB를 채우지 않게).
export const UNUSED_IMAGE_LIMIT = 30;
// 이보다 오래된 쓰지 않는 이미지는 다음 업로드 때 지운다.
const UNUSED_IMAGE_TTL_MS = 24 * 3600_000;

export type ShopImageRejection =
  | "empty_file"
  | "file_too_large"
  | "unsupported_image"
  | "wrong_image_size"
  | "png_16bit"
  | "png_too_large"
  | "too_many_unused_images";

export const SHOP_IMAGE_MESSAGES: Record<ShopImageRejection, string> = {
  empty_file: "빈 파일은 올릴 수 없습니다",
  file_too_large: "이미지는 2MB까지 올릴 수 있습니다",
  unsupported_image: "PNG 파일만 올릴 수 있습니다",
  wrong_image_size: `이미지 가로·세로는 ${SHOP_IMAGE_MIN_SIDE}~${SHOP_IMAGE_MAX_SIDE}px, 전체 1920×1080 화소 이하여야 합니다`,
  png_16bit: "8비트(일반) PNG로 저장해 주십시오. 16비트 PNG는 올릴 수 없습니다",
  png_too_large: "이미지 데이터가 너무 큽니다. 8비트(일반) PNG로 저장하거나 크기를 줄여 주십시오",
  too_many_unused_images: "아직 쓰지 않은 이미지가 많습니다. 배너·팝업을 저장한 뒤 다시 올려 주십시오",
};

export type ShopImageInfo = { type: "image/png"; width: number; height: number };

// 쇼핑몰 쪽 이미지 업로드(배너·팝업 이미지, 쇼핑몰 로고)가 모두 거치는 PNG 검사. 순서:
// 빈 파일·용량 → PNG 머리(IHDR) → 크기(경로마다 sizeReason) → 16비트 → 풀린 크기 → 브랜딩 검사기 detectImage(그림 데이터까지).
// 브랜딩 검사기는 풀린 그림 데이터가 상한을 넘으면 형식 오류로 거부하므로, 「PNG만」 같은 엉뚱한 안내가 나가지 않게
// 16비트는 먼저 따로 막고, 그 밖에 상한을 넘는 조합(색 형식·인터레이스)도 풀기 전에 사유를 알려 준다.
export type PngRejection = "empty_file" | "file_too_large" | "unsupported_image" | "png_16bit" | "png_too_large";

export function checkPng<R extends string>(
  b: Buffer,
  maxBytes: number,
  sizeReason: (width: number, height: number) => R | null,
): { ok: true; width: number; height: number } | { ok: false; reason: PngRejection | R } {
  if (b.length === 0) return { ok: false, reason: "empty_file" };
  if (b.length > maxBytes) return { ok: false, reason: "file_too_large" };
  const head = pngHeader(b);
  if (!head) return { ok: false, reason: "unsupported_image" };
  const size = sizeReason(head.width, head.height);
  if (size) return { ok: false, reason: size };
  if (head.depth === 16) return { ok: false, reason: "png_16bit" };
  if (pngRawSize(head) > PNG_DECODE_LIMIT) return { ok: false, reason: "png_too_large" };
  const info = detectImage(b);
  if (!info || info.type !== "image/png") return { ok: false, reason: "unsupported_image" };
  return { ok: true, width: info.width, height: info.height };
}

// 배너·팝업 이미지
export function checkShopImage(b: Buffer): { ok: true; info: ShopImageInfo } | { ok: false; reason: ShopImageRejection } {
  const r = checkPng(b, SHOP_IMAGE_MAX_BYTES, (w, h) => (sizeOk(w, h) ? null : "wrong_image_size"));
  return r.ok ? { ok: true, info: { type: "image/png", width: r.width, height: r.height } } : r;
}

const sizeOk = (w: number, h: number) =>
  w >= SHOP_IMAGE_MIN_SIDE && w <= SHOP_IMAGE_MAX_SIDE && h >= SHOP_IMAGE_MIN_SIDE && h <= SHOP_IMAGE_MAX_SIDE && w * h <= SHOP_IMAGE_MAX_PIXELS;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
type PngHeader = { width: number; height: number; depth: number; color: number; interlace: number };
// 시그니처와 IHDR(첫 33바이트)의 크기·비트 깊이·색 형식·인터레이스. 형식 판정(조합이 맞는지 등)은 detectImage가 한다.
function pngHeader(b: Buffer): PngHeader | null {
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIGNATURE) || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), depth: b[24], color: b[25], interlace: b[28] };
}

// 브랜딩 검사기(lib/server/branding/image.ts)가 풀어 보는 그림 데이터 상한. 그 파일의 PNG_MAX_RAW와 같은 값이어야 한다.
const PNG_DECODE_LIMIT = 8_400_000;
const PNG_CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
// 풀린 그림 데이터 길이(줄마다 필터 1바이트 + 줄 바이트, Adam7은 단계별). 모르는 색 형식이면 0(형식 판정은 detectImage).
export function pngRawSize(h: Pick<PngHeader, "width" | "height" | "depth" | "color" | "interlace">): number {
  const bits = (PNG_CHANNELS[h.color] ?? 0) * h.depth;
  const rowBytes = (w: number) => Math.ceil((w * bits) / 8);
  if (h.interlace !== 1) return h.height * (1 + rowBytes(h.width));
  return ADAM7.reduce((n, [x0, y0, dx, dy]) => {
    const w = h.width > x0 ? Math.ceil((h.width - x0) / dx) : 0;
    const rows = h.height > y0 ? Math.ceil((h.height - y0) / dy) : 0;
    return n + (w === 0 ? 0 : rows * (1 + rowBytes(w)));
  }, 0);
}

export type ShopImageMeta = { id: string; contentType: string; width: number; height: number; byteSize: number; version: string };

export const imageVersion = (sha256: string) => sha256.slice(0, 12);

// 아무 배너·팝업도 가리키지 않는 이미지 조건(SQL)
const UNUSED = `NOT EXISTS (SELECT 1 FROM "ShopBanner" b WHERE b."sellerId" = i."sellerId" AND (b."pcImageId" = i."id" OR b."mobileImageId" = i."id"))
  AND NOT EXISTS (SELECT 1 FROM "ShopPopup" p WHERE p."sellerId" = i."sellerId" AND p."imageId" = i."id")`;

// 이미지 올리기. 대표자·SHOP_SETTINGS만. 쓰지 않은 오래된 이미지를 먼저 지우고, 쓰지 않은 이미지가 한도면 거부한다.
export async function uploadShopImage(
  db: PrismaClient,
  ctx: TenantContext,
  bytes: Buffer,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ ok: true; image: ShopImageMeta } | { ok: false; reason: ShopImageRejection }> {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const check = checkShopImage(bytes);
  if (!check.ok) return check;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return db.$transaction(async (tx) => {
    // 같은 쇼핑몰의 쇼핑몰 꾸미기 변경을 한 줄로 세운다(개수 한도 판정이 동시 요청에 깨지지 않게)
    await tx.$queryRaw`SELECT 1 FROM "Seller" WHERE "id" = ${ctx.sellerId}::uuid FOR UPDATE`;
    await tx.$executeRawUnsafe(
      `DELETE FROM "ShopContentImage" i WHERE i."sellerId" = $1::uuid AND i."createdAt" < now() - make_interval(secs => $2::int) AND ${UNUSED}`,
      ctx.sellerId,
      UNUSED_IMAGE_TTL_MS / 1000,
    );
    const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "ShopContentImage" i WHERE i."sellerId" = $1::uuid AND ${UNUSED}`,
      ctx.sellerId,
    );
    if (n >= UNUSED_IMAGE_LIMIT) return { ok: false as const, reason: "too_many_unused_images" as const };
    const row = await tx.shopContentImage.create({
      data: {
        sellerId: ctx.sellerId,
        data: new Uint8Array(bytes),
        contentType: check.info.type,
        byteSize: bytes.length,
        width: check.info.width,
        height: check.info.height,
        sha256,
      },
      select: { id: true },
    });
    const image = { id: row.id, contentType: check.info.type, width: check.info.width, height: check.info.height, byteSize: bytes.length, version: imageVersion(sha256) };
    // 바이트 대신 형식·크기·해시만 남긴다
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop.content_image.upload",
      targetType: "ShopContentImage",
      targetId: row.id,
      after: { contentType: image.contentType, width: image.width, height: image.height, byteSize: image.byteSize, sha256 },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, image };
  });
}

// 배너·팝업을 지우거나 이미지를 바꾼 뒤 더는 쓰지 않는 이미지를 지운다(같은 트랜잭션 안에서).
export async function deleteUnusedImages(tx: Pick<PrismaClient, "$executeRawUnsafe">, sellerId: string, ids: (string | null | undefined)[]) {
  const list = [...new Set(ids.filter((v): v is string => !!v))];
  if (list.length === 0) return;
  await tx.$executeRawUnsafe(`DELETE FROM "ShopContentImage" i WHERE i."sellerId" = $1::uuid AND i."id" = ANY($2::uuid[]) AND ${UNUSED}`, sellerId, list);
}

// 이미지 응답. 저장할 때 바이트로 확인한 형식을 Content-Type으로 쓰고 nosniff를 붙인다.
// 주소의 v가 지금 이미지 해시와 같으면 1년 immutable(내용이 바뀌면 주소가 바뀐다), 아니면 짧게 캐시한다.
// 공개 주소는 public, 파트너스 관리자 미리보기는 private.
export function imageResponse(req: Request, row: { data: Uint8Array; contentType: string; sha256: string }, scope: "public" | "private"): Response {
  const version = imageVersion(row.sha256);
  const fresh = new URL(req.url).searchParams.get("v") === version;
  const etag = `"${row.sha256}"`;
  const headers = {
    "content-type": row.contentType,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    etag,
    "cache-control": fresh ? `${scope}, max-age=31536000, immutable` : `${scope}, max-age=60`,
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(row.data), { headers });
}
