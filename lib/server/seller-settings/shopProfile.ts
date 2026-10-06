import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 쇼핑몰 정보(SA-060, SHOP_SETTINGS): 쇼핑몰 이름(필수 20자)·한 줄 소개(선택 40자)·운영 상태(OPEN 운영 중·PREPARING 준비 중·PAUSED 일시 정지, 빼면 유지). 주소(slug)는 바꾸지 않는다.
export const SHOP_NAME_MAX = 20;
export const SHOP_TAGLINE_MAX = 40;

export const OPERATING_STATES = ["OPEN", "PREPARING", "PAUSED"] as const;
export type OperatingState = (typeof OPERATING_STATES)[number];
export type ShopProfile = { shopName: string; shopTagline: string | null; operatingState: OperatingState };

export const SHOP_PROFILE_MESSAGES = {
  invalid_shop_profile: `쇼핑몰 이름은 ${SHOP_NAME_MAX}자 이내로 꼭 입력해 주십시오. 한 줄 소개는 ${SHOP_TAGLINE_MAX}자까지 쓸 수 있습니다. 운영 상태는 운영 중·준비 중·일시 정지 중 하나입니다`,
} as const;

export async function readShopProfile(db: PrismaClient, ctx: TenantContext): Promise<ShopProfile> {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  const s = await db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { shopName: true, shopTagline: true, operatingState: true } });
  return { shopName: s.shopName, shopTagline: s.shopTagline, operatingState: s.operatingState };
}

// 본문: { shopName?: string, shopTagline?: string | null }. 빼면 지금 값 유지, 한 줄 소개는 빈 값·null이면 지운다. 모르는 키·빈 본문은 거부.
// 대표자·SHOP_SETTINGS만(그 밖 403), 바뀐 값이 있을 때만 로그 추적에 남긴다.
export async function updateShopProfile(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const bad = { ok: false as const, reason: "invalid_shop_profile" as const };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad;
  const b = raw as Record<string, unknown>;
  const given = Object.keys(b);
  if (given.length === 0 || given.some((k) => k !== "shopName" && k !== "shopTagline" && k !== "operatingState")) return bad;
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
  if ("operatingState" in b) {
    if (typeof b.operatingState !== "string" || !(OPERATING_STATES as readonly string[]).includes(b.operatingState)) return bad;
    patch.operatingState = b.operatingState as OperatingState;
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop_profile:${ctx.sellerId}`}))`;
    const before = await tx.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { shopName: true, shopTagline: true, operatingState: true } });
    const after: ShopProfile = { ...before, ...patch };
    if (after.shopName !== before.shopName || after.shopTagline !== before.shopTagline || after.operatingState !== before.operatingState) {
      await tx.seller.update({ where: { id: ctx.sellerId }, data: { shopName: after.shopName, shopTagline: after.shopTagline, operatingState: after.operatingState } });
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
