import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { detectImage } from "../branding/image";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, type TenantContext } from "../tenant/context";

// 배너·팝업 이미지. 형식은 확장자·Content-Type이 아니라 바이트로 확인한다(브랜딩 검사기 detectImage 재사용:
// PNG는 그림 데이터를 실제로 풀어 보고, JPEG는 표식 구조와 그림 데이터를 확인한다). SVG·WebP·GIF는 받지 않는다.
// 저장은 대표님 저장 방식 결정 전까지 A안(DB bytea). 크기·형식 CHECK는 마이그레이션 20261004160000_shop_content와 같은 값.
export const SHOP_IMAGE_MAX_BYTES = 3 * 1024 * 1024;
export const SHOP_IMAGE_MIN_SIDE = 100;
// PNG를 풀 때 상한(16MB)에 걸리지 않는 크기. 1920×600 PC 배너, 1080×1080 모바일 배너가 들어간다.
export const SHOP_IMAGE_MAX_SIDE = 2000;
// 아직 배너·팝업에 쓰지 않은 이미지는 쇼핑몰당 이 개수까지만 둔다(올리기만 반복해 DB를 채우지 않게).
export const UNUSED_IMAGE_LIMIT = 30;
// 이보다 오래된 쓰지 않는 이미지는 다음 업로드 때 지운다.
const UNUSED_IMAGE_TTL_MS = 24 * 3600_000;

export type ShopImageRejection = "empty_file" | "file_too_large" | "unsupported_image" | "wrong_image_size" | "too_many_unused_images";

export const SHOP_IMAGE_MESSAGES: Record<ShopImageRejection, string> = {
  empty_file: "빈 파일은 올릴 수 없습니다",
  file_too_large: "이미지는 3MB까지 올릴 수 있습니다",
  unsupported_image: "PNG·JPEG 이미지만 올릴 수 있습니다",
  wrong_image_size: `이미지 가로·세로는 ${SHOP_IMAGE_MIN_SIDE}~${SHOP_IMAGE_MAX_SIDE}px이어야 합니다`,
  too_many_unused_images: "아직 쓰지 않은 이미지가 많습니다. 배너·팝업을 저장한 뒤 다시 올려 주십시오",
};

export type ShopImageInfo = { type: "image/png" | "image/jpeg"; width: number; height: number };

export function checkShopImage(b: Buffer): { ok: true; info: ShopImageInfo } | { ok: false; reason: ShopImageRejection } {
  if (b.length === 0) return { ok: false, reason: "empty_file" };
  if (b.length > SHOP_IMAGE_MAX_BYTES) return { ok: false, reason: "file_too_large" };
  const info = detectImage(b);
  if (!info || (info.type !== "image/png" && info.type !== "image/jpeg")) return { ok: false, reason: "unsupported_image" };
  if (info.type === "image/jpeg" && !jpegTablesOk(b)) return { ok: false, reason: "unsupported_image" };
  const side = (n: number) => n >= SHOP_IMAGE_MIN_SIDE && n <= SHOP_IMAGE_MAX_SIDE;
  if (!side(info.width) || !side(info.height)) return { ok: false, reason: "wrong_image_size" };
  return { ok: true, info: { type: info.type, width: info.width, height: info.height } };
}

// JPEG 표 확인(브랜딩 검사기 위에 더한다). 첫 스캔 전까지 프레임의 각 요소가 쓰는 양자화표(DQT)가 정의되고,
// 스캔의 각 요소가 쓰는 허프만표(DHT, DC·AC)가 정의돼 있어야 한다(산술 부호화 프레임은 DAC 기본값이 있어 허프만표를 보지 않는다).
// 표가 빠진 파일은 머리 구조가 맞아도 브라우저가 그리지 못한다. 그림 데이터 전체를 푸는 확인은 하지 않는다(디코더 의존성 없음).
export function jpegTablesOk(b: Buffer): boolean {
  const quant = new Set<number>();
  const huff = new Set<string>();
  let frameQuant: number[] = [];
  let arithmetic = false;
  let o = 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return false;
    const m = b[o + 1];
    if (m === 0xff) {
      o++;
      continue;
    }
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) {
      o += 2;
      continue;
    }
    const len = b.readUInt16BE(o + 2);
    const end = o + 2 + len;
    if (len < 2 || end > b.length) return false;
    if (m === 0xdb) {
      // DQT: [정밀도(4)·번호(4)] + 64개 값(정밀도 0이면 1바이트, 1이면 2바이트), 여러 개가 이어질 수 있다
      for (let i = o + 4; i < end; ) {
        const pq = b[i] >> 4;
        quant.add(b[i] & 0x0f);
        i += 1 + 64 * (pq ? 2 : 1);
        if (i > end) return false;
      }
    } else if (m === 0xc4) {
      // DHT: [종류(4)·번호(4)] + 길이별 개수 16바이트 + 값들
      for (let i = o + 4; i < end; ) {
        if (i + 17 > end) return false;
        huff.add(`${b[i] >> 4}:${b[i] & 0x0f}`);
        let n = 0;
        for (let k = 1; k <= 16; k++) n += b[i + k];
        i += 17 + n;
        if (i > end) return false;
      }
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      arithmetic = m >= 0xc9;
      const nc = b[o + 9];
      frameQuant = Array.from({ length: nc }, (_, i) => b[o + 12 + i * 3]);
    } else if (m === 0xda) {
      if (!frameQuant.every((q) => quant.has(q))) return false;
      if (arithmetic) return true;
      const ns = b[o + 4];
      for (let i = 0; i < ns; i++) {
        const t = b[o + 6 + i * 2];
        if (!huff.has(`0:${t >> 4}`) || !huff.has(`1:${t & 0x0f}`)) return false;
      }
      return true;
    }
    o = end;
  }
  return false;
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
