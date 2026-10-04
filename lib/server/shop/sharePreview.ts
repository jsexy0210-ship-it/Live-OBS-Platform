import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { writeAudit } from "../audit/log";
import { shopOpen } from "../buyers/signup";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 쇼핑몰 공유 미리보기(SA-060, PRODUCT_SCOPE 「쇼핑몰 파비콘·공유 미리보기」). MASTER 결정 2026-10-04(대기열 4번 C안):
// 이미지 저장소를 정하기 전이라 제목·설명 설정과 쇼핑몰 이름으로 서버에서 그리는 기본 카드(ogCard.ts)만 만든다.
// 파비콘·카드 이미지 업로드와 로고는 저장소 결정 뒤에 붙인다(그 전까지 파비콘은 ONQ 기본값).
export const SHARE_TITLE_MAX = 60;
export const SHARE_DESCRIPTION_MAX = 160;

export type SharePreview = { title: string | null; description: string | null };

export const SHARE_PREVIEW_MESSAGES = {
  invalid_share_preview: `제목은 ${SHARE_TITLE_MAX}자, 설명은 ${SHARE_DESCRIPTION_MAX}자까지 쓸 수 있습니다`,
} as const;

export async function readSharePreview(db: PrismaClient, ctx: TenantContext): Promise<SharePreview> {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  const s = await db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { shareTitle: true, shareDescription: true } });
  return { title: s.shareTitle, description: s.shareDescription };
}

// 본문: { title: string | null, description: string | null }. 빈 문자열·null이면 지운다(기본값으로). 대표자·SHOP_SETTINGS만, 감사 기록.
export async function updateSharePreview(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const title = field(b.title, SHARE_TITLE_MAX, "name");
  const description = field(b.description, SHARE_DESCRIPTION_MAX, "memo");
  if (title === undefined || description === undefined) return { ok: false as const, reason: "invalid_share_preview" as const };
  return db.$transaction(async (tx) => {
    const before = await tx.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { shareTitle: true, shareDescription: true } });
    await tx.seller.update({ where: { id: ctx.sellerId }, data: { shareTitle: title, shareDescription: description } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop.share_preview.update",
      targetType: "Seller",
      targetId: ctx.sellerId,
      before: { title: before.shareTitle, description: before.shareDescription },
      after: { title, description },
    });
    return { ok: true as const, preview: { title, description } };
  });
}

// null·빈 문자열 → null(지움), 글자 → 정리한 값, 그 밖(형식·길이·보이지 않는 문자) → undefined(거부)
function field(v: unknown, max: number, kind: "name" | "memo"): string | null | undefined {
  if (v === null || v === "") return null;
  return cleanText(v, max, kind) ?? undefined;
}

export type ShareMeta = {
  title: string;
  description: string | null;
  image: { url: string; width: 1200; height: 630 };
  // 쇼핑몰 파비콘. 업로드 전에는 null(화면의 ONQ 기본 아이콘을 쓴다).
  favicon: null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 공개 쇼핑몰 페이지의 공유 미리보기 값(og:title·og:description·og:image). 운영 중이고 잠기지 않은 쇼핑몰만(아니면 null).
// 상품 상세(productId)는 판매 중·품절 상품의 이름이 제목으로 우선한다. 상품 대표 이미지는 상품 이미지 업로드가 생긴 뒤 연결한다.
export async function shopShareMeta(db: PrismaClient, slug: string, productId?: string | null): Promise<ShareMeta | null> {
  const shop = await db.seller.findUnique({ where: { slug }, select: { id: true, slug: true, shopName: true, shareTitle: true, shareDescription: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  const product =
    productId && UUID.test(productId)
      ? await db.product.findFirst({ where: { id: productId, sellerId: shop.id, deletedAt: null, status: { in: ["ON_SALE", "SOLD_OUT"] } }, select: { name: true } })
      : null;
  return {
    title: product?.name ?? shop.shareTitle ?? shop.shopName,
    description: shop.shareDescription,
    image: { url: `/api/shop/${encodeURIComponent(shop.slug)}/og.png?v=${cardVersion(shop.shopName)}`, width: 1200, height: 630 },
    favicon: null,
  };
}

// 기본 카드 그림이 바뀌는 값(쇼핑몰 이름)의 짧은 해시. 이름을 바꾸면 주소가 바뀌어 공유 서비스 캐시가 새 그림을 받는다.
export function cardVersion(shopName: string): string {
  return createHash("sha256").update(`og-card-v1\0${shopName}`).digest("hex").slice(0, 12);
}
