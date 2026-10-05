import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 쇼핑몰 정보(SA-060, SHOP_SETTINGS): 쇼핑몰 이름(필수 20자)·한 줄 소개(선택 40자). 주소(slug)는 바꾸지 않는다.
export const SHOP_NAME_MAX = 20;
export const SHOP_TAGLINE_MAX = 40;

export type ShopProfile = { shopName: string; shopTagline: string | null };

export const SHOP_PROFILE_MESSAGES = {
  invalid_shop_profile: `쇼핑몰 이름은 ${SHOP_NAME_MAX}자 이내로 꼭 입력해 주십시오. 한 줄 소개는 ${SHOP_TAGLINE_MAX}자까지 쓸 수 있습니다`,
} as const;

export async function readShopProfile(db: PrismaClient, ctx: TenantContext): Promise<ShopProfile> {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  const s = await db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { shopName: true, shopTagline: true } });
  return { shopName: s.shopName, shopTagline: s.shopTagline };
}

// 본문: { shopName?: string, shopTagline?: string | null }. 빼면 지금 값 유지, 한 줄 소개는 빈 값·null이면 지운다. 모르는 키·빈 본문은 거부.
// 대표자·SHOP_SETTINGS만(그 밖 403), 바뀐 값이 있을 때만 로그 추적에 남긴다.
export async function updateShopProfile(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const bad = { ok: false as const, reason: "invalid_shop_profile" as const };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad;
  const b = raw as Record<string, unknown>;
  const given = Object.keys(b);
  if (given.length === 0 || given.some((k) => k !== "shopName" && k !== "shopTagline")) return bad;
  const patch: Partial<ShopProfile> = {};
  if ("shopName" in b) {
    const n = cleanText(b.shopName, SHOP_NAME_MAX, "name");
    if (n === null) return bad;
    patch.shopName = n;
  }
  if ("shopTagline" in b) {
    if (b.shopTagline === null || b.shopTagline === "") patch.shopTagline = null;
    else {
      const t = cleanText(b.shopTagline, SHOP_TAGLINE_MAX, "memo");
      if (t === null) return bad;
      patch.shopTagline = t;
    }
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop_profile:${ctx.sellerId}`}))`;
    const before = await tx.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { shopName: true, shopTagline: true } });
    const after: ShopProfile = { ...before, ...patch };
    if (after.shopName !== before.shopName || after.shopTagline !== before.shopTagline) {
      await tx.seller.update({ where: { id: ctx.sellerId }, data: { shopName: after.shopName, shopTagline: after.shopTagline } });
      await writeAudit(tx, {
        actorType: ctx.actorType,
        actorId: ctx.actorId,
        sellerId: ctx.sellerId,
        action: "shop.profile.update",
        targetType: "Seller",
        targetId: ctx.sellerId,
        before,
        after,
      });
    }
    return { ok: true as const, profile: after };
  });
}
