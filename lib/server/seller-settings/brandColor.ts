import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 쇼핑몰 대표 색상(SA-060, SHOP_SETTINGS). 강조색(버튼·가격 강조)에만 쓰고 바탕은 흰색이므로(DESIGN_PROMPT) 흰 바탕과의 대비가 3:1 미만인
// 너무 옅은 색은 받지 않는다(글자·버튼이 안 보임). 값은 #RRGGBB 대문자로 저장한다. null(또는 빈 값)이면 지우고 플랫폼 기본 강조색을 쓴다.
export const MIN_CONTRAST_ON_WHITE = 3;

export const BRAND_COLOR_MESSAGES = {
  invalid_brand_color: "색상은 #RRGGBB 형식으로 입력해 주십시오",
  brand_color_too_light: "너무 옅은 색입니다. 흰 바탕에서 잘 보이는 더 진한 색을 골라 주십시오",
} as const;

type Db = PrismaClient | Prisma.TransactionClient;

const linear = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

// 흰색(#FFFFFF)과의 대비 비율(WCAG 2). 1(흰색)~21(검정), 소수 둘째 자리.
export function contrastOnWhite(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const l = 0.2126 * linear((n >> 16) & 255) + 0.7152 * linear((n >> 8) & 255) + 0.0722 * linear(n & 255);
  return Math.round((1.05 / (l + 0.05)) * 100) / 100;
}

export type BrandColor = { color: string | null; contrastOnWhite: number | null };

const view = (color: string | null): BrandColor => ({ color, contrastOnWhite: color ? contrastOnWhite(color) : null });

export async function readBrandColorOf(db: Db, sellerId: string): Promise<string | null> {
  return (await db.sellerBrandColor.findUnique({ where: { sellerId }, select: { color: true } }))?.color ?? null;
}

export async function readBrandColor(db: PrismaClient, ctx: TenantContext): Promise<BrandColor> {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  return view(await readBrandColorOf(db, ctx.sellerId));
}

// 본문: { color: "#RRGGBB" | null }. 소문자·앞뒤 공백은 정리한다. 이미 같은 값이면 바꾸지 않고 로그도 남기지 않는다.
export async function updateBrandColor(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!b || !("color" in b) || Object.keys(b).length !== 1) return { ok: false as const, reason: "invalid_brand_color" as const };
  let color: string | null;
  if (b.color === null || b.color === "") color = null;
  else if (typeof b.color === "string" && /^#[0-9A-Fa-f]{6}$/.test(b.color.trim())) color = b.color.trim().toUpperCase();
  else return { ok: false as const, reason: "invalid_brand_color" as const };
  if (color && contrastOnWhite(color) < MIN_CONTRAST_ON_WHITE) return { ok: false as const, reason: "brand_color_too_light" as const };
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`seller_brand_color:${ctx.sellerId}`}))`;
    const before = await readBrandColorOf(tx, ctx.sellerId);
    if (before === color) return { ok: true as const, brandColor: view(color) };
    if (color === null) await tx.sellerBrandColor.deleteMany({ where: { sellerId: ctx.sellerId } });
    else await tx.sellerBrandColor.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, color }, update: { color } });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "shop.brand_color.update", targetType: "Seller", targetId: ctx.sellerId, before: { color: before }, after: { color } });
    return { ok: true as const, brandColor: view(color) };
  });
}
