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
// 전체 화소 수 상한. 브랜딩 검사기가 풀어 보는 그림 데이터 상한(8,400,000바이트) 안에 8비트 RGBA가 들어가는 값이다
// (2,000,000 × 4 + 줄 머리 = 약 8,002,000바이트). 권장 크기(PC 배너 1200×400, 모바일 750×750, 팝업 600×600)는 넉넉히 들어간다.
export const SHOP_IMAGE_MAX_PIXELS = 2_000_000;
// 아직 배너·팝업에 쓰지 않은 이미지는 쇼핑몰당 이 개수까지만 둔다(올리기만 반복해 DB를 채우지 않게).
export const UNUSED_IMAGE_LIMIT = 30;
// 이보다 오래된 쓰지 않는 이미지는 다음 업로드 때 지운다.
const UNUSED_IMAGE_TTL_MS = 24 * 3600_000;

export type ShopImageRejection = "empty_file" | "file_too_large" | "unsupported_image" | "wrong_image_size" | "too_many_unused_images";

export const SHOP_IMAGE_MESSAGES: Record<ShopImageRejection, string> = {
  empty_file: "빈 파일은 올릴 수 없습니다",
  file_too_large: "이미지는 2MB까지 올릴 수 있습니다",
  unsupported_image: "PNG 파일만 올릴 수 있습니다",
  wrong_image_size: `이미지 가로·세로는 ${SHOP_IMAGE_MIN_SIDE}~${SHOP_IMAGE_MAX_SIDE}px, 전체 200만 화소 이하여야 합니다`,
  too_many_unused_images: "아직 쓰지 않은 이미지가 많습니다. 배너·팝업을 저장한 뒤 다시 올려 주십시오",
};

export type ShopImageInfo = { type: "image/png"; width: number; height: number };

export function checkShopImage(b: Buffer): { ok: true; info: ShopImageInfo } | { ok: false; reason: ShopImageRejection } {
  if (b.length === 0) return { ok: false, reason: "empty_file" };
  if (b.length > SHOP_IMAGE_MAX_BYTES) return { ok: false, reason: "file_too_large" };
  // 크기는 PNG 머리(IHDR)로 먼저 본다. 크기가 틀린 파일은 풀기 전에 「크기」로 안내한다.
  const head = pngSize(b);
  if (!head) return { ok: false, reason: "unsupported_image" };
  if (!sizeOk(head.width, head.height)) return { ok: false, reason: "wrong_image_size" };
  const info = detectImage(b);
  if (!info || info.type !== "image/png") return { ok: false, reason: "unsupported_image" };
  return { ok: true, info: { type: "image/png", width: info.width, height: info.height } };
}

const sizeOk = (w: number, h: number) =>
  w >= SHOP_IMAGE_MIN_SIDE && w <= SHOP_IMAGE_MAX_SIDE && h >= SHOP_IMAGE_MIN_SIDE && h <= SHOP_IMAGE_MAX_SIDE && w * h <= SHOP_IMAGE_MAX_PIXELS;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// 시그니처와 IHDR(첫 33바이트)의 가로·세로. 형식 판정은 detectImage가 한다.
export function pngSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 33 || !b.subarray(0, 8).equals(PNG_SIGNATURE) || b.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
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
