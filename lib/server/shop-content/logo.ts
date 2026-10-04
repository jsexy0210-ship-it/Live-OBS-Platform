import type { Prisma, PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { writeAudit } from "../audit/log";
import { shopOpen } from "../buyers/signup";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { checkPng, imageVersion, type PngRejection } from "./image";

// 쇼핑몰 로고(SA-060 쇼핑몰 정보, 2026-10-04 대표님 지시). 쇼핑몰당 1개.
// 8비트 PNG만(배너·팝업과 같은 검사 checkPng: 16비트·풀기 상한 초과는 먼저 따로 안내, 브랜딩 검사기로 그림 데이터까지 확인), 2MB 이하, 정사각형, 512px 이상.
// 한 변 상한 1440px은 브랜딩 검사기가 풀어 보는 그림 데이터 상한(8,400,000바이트) 안에 8비트 RGBA가 들어가는 크기다
// (1440 × (1 + 1440 × 4) = 8,295,840바이트). 마이그레이션 20261004170000_shop_logo CHECK와 같은 값.
// 보기는 같은 쇼핑몰의 파트너스 계정 누구나, 바꾸기·지우기는 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 직원만. 바꾸면 로그 추적에 남긴다.
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
export const LOGO_MIN_SIDE = 512;
export const LOGO_MAX_SIDE = 1440;

export type LogoRejection = PngRejection | "not_square" | "wrong_image_size";

export const LOGO_MESSAGES: Record<LogoRejection, string> = {
  empty_file: "빈 파일은 올릴 수 없습니다",
  file_too_large: "로고는 2MB까지 올릴 수 있습니다",
  unsupported_image: "PNG 파일만 올릴 수 있습니다",
  not_square: "로고는 가로와 세로가 같은 정사각형이어야 합니다",
  wrong_image_size: `로고는 ${LOGO_MIN_SIDE}~${LOGO_MAX_SIDE}px 정사각형이어야 합니다`,
  png_16bit: "8비트(일반) PNG로 저장해 주십시오. 16비트 PNG는 올릴 수 없습니다",
  png_too_large: "이미지 데이터가 너무 큽니다. 8비트(일반) PNG로 저장하거나 크기를 줄여 주십시오",
};

// 배너·팝업과 같은 PNG 검사(checkPng)를 거친다. 크기 사유만 로고 기준(정사각형, 512~1440px).
export function checkLogo(b: Buffer): { ok: true; width: number } | { ok: false; reason: LogoRejection } {
  const r = checkPng(b, LOGO_MAX_BYTES, (w, h): "not_square" | "wrong_image_size" | null =>
    w !== h ? "not_square" : w < LOGO_MIN_SIDE || w > LOGO_MAX_SIDE ? "wrong_image_size" : null,
  );
  return r.ok ? { ok: true, width: r.width } : r;
}

export type LogoView = { url: string; size: number; byteSize: number } | null;

const view = (r: { size: number; byteSize: number; sha256: string } | null): LogoView =>
  r ? { url: `/api/seller/shop-content/logo/image?v=${imageVersion(r.sha256)}`, size: r.size, byteSize: r.byteSize } : null;

export async function readLogo(db: PrismaClient, ctx: TenantContext): Promise<LogoView> {
  // 조회는 같은 쇼핑몰 계정이면 누구나(보기만)
  const r = await db.sellerLogo.findUnique({ where: { sellerId: ctx.sellerId }, select: { width: true, byteSize: true, sha256: true } });
  return view(r ? { size: r.width, byteSize: r.byteSize, sha256: r.sha256 } : null);
}

type Meta = { ip?: string | null; userAgent?: string | null };

// 같은 쇼핑몰의 로고 바꾸기·지우기를 한 줄로 처리한다(동시 지우기 두 번째는 할 일 없음으로 성공, 동시 첫 올리기는 유니크 충돌 없이 차례로).
// 배너·팝업과 같은 쇼핑몰 행 잠금. NO KEY UPDATE라 쇼핑몰을 가리키는 행 추가(주문 등)는 막지 않는다.
const lockShopLogo = (tx: Prisma.TransactionClient, sellerId: string) => tx.$queryRaw`SELECT 1 FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR NO KEY UPDATE`;

export async function putLogo(db: PrismaClient, ctx: TenantContext, bytes: Buffer, meta: Meta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const check = checkLogo(bytes);
  if (!check.ok) return check;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const data = { data: new Uint8Array(bytes), contentType: "image/png", byteSize: bytes.length, width: check.width, height: check.width, sha256 };
  return db.$transaction(async (tx) => {
    await lockShopLogo(tx, ctx.sellerId);
    const before = await tx.sellerLogo.findUnique({ where: { sellerId: ctx.sellerId }, select: { width: true, byteSize: true, sha256: true } });
    await tx.sellerLogo.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: data });
    // 바이트 대신 크기·해시만 남긴다
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop.logo.update",
      targetType: "SellerLogo",
      targetId: ctx.sellerId,
      before: before ?? undefined,
      after: { width: check.width, byteSize: bytes.length, sha256 },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return { ok: true as const, logo: view({ size: check.width, byteSize: bytes.length, sha256 }) };
  });
}

// 지우면 구매자 머리는 쇼핑몰 이름 첫 글자로 돌아간다. 없는 로고를 지우는 것은 아무것도 남기지 않는다.
export async function deleteLogo(db: PrismaClient, ctx: TenantContext, meta: Meta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  await db.$transaction(async (tx) => {
    await lockShopLogo(tx, ctx.sellerId);
    const before = await tx.sellerLogo.findUnique({ where: { sellerId: ctx.sellerId }, select: { width: true, byteSize: true, sha256: true } });
    if (!before) return;
    await tx.sellerLogo.delete({ where: { sellerId: ctx.sellerId } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop.logo.delete",
      targetType: "SellerLogo",
      targetId: ctx.sellerId,
      before,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
}

export async function sellerLogoImage(db: PrismaClient, ctx: TenantContext) {
  return db.sellerLogo.findUnique({ where: { sellerId: ctx.sellerId }, select: { data: true, contentType: true, sha256: true } });
}

// 구매자 화면 로고. 운영 중이고 스토어 운영 권한이 있는 쇼핑몰만(아니면 null).
export async function publicLogo(db: PrismaClient, slug: string) {
  const shop = await db.seller.findUnique({ where: { slug }, select: { id: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  return db.sellerLogo.findUnique({ where: { sellerId: shop.id }, select: { data: true, contentType: true, sha256: true } });
}
