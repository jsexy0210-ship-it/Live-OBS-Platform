import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 쇼핑몰 검색 노출(SA-067, SHOP_SETTINGS). 검색 제목·설명, 검색 노출 끄기, 사이트맵, 상품별 제목·설명 규칙, 검색 사이트 소유 확인 코드.
// 파비콘·공유 카드는 SA-060(sharePreview.ts). 행이 없으면 기본값(노출·사이트맵 켬, 나머지 비움).
// 상품별 규칙에는 {상품명}·{쇼핑몰}만 쓸 수 있다(공개 화면이 채운다). 소유 확인 코드는 검색 사이트가 주는 메타 태그 content 값(영문·숫자·-_ 만).
export const SEO_TITLE_MAX = 60;
export const SEO_DESCRIPTION_MAX = 160;
export const SEO_VERIFICATION_MAX = 100;
const PLACEHOLDERS = new Set(["상품명", "쇼핑몰"]);
const VERIFICATION = /^[A-Za-z0-9_-]+$/;

export type ShopSeoSettings = {
  searchTitle: string | null;
  searchDescription: string | null;
  indexingEnabled: boolean;
  sitemapEnabled: boolean;
  productTitleTemplate: string | null;
  productDescriptionTemplate: string | null;
  googleVerification: string | null;
  naverVerification: string | null;
};
type Key = keyof ShopSeoSettings;

export const SHOP_SEO_MESSAGES = {
  invalid_shop_seo: `제목은 ${SEO_TITLE_MAX}자, 설명은 ${SEO_DESCRIPTION_MAX}자까지 쓸 수 있습니다. 규칙에는 {상품명}·{쇼핑몰}만 쓸 수 있고, 확인 코드는 영문·숫자·-_ ${SEO_VERIFICATION_MAX}자까지입니다`,
} as const;

const DEFAULTS: ShopSeoSettings = {
  searchTitle: null,
  searchDescription: null,
  indexingEnabled: true,
  sitemapEnabled: true,
  productTitleTemplate: null,
  productDescriptionTemplate: null,
  googleVerification: null,
  naverVerification: null,
};
const KEYS = Object.keys(DEFAULTS) as Key[];
const BOOLS: Key[] = ["indexingEnabled", "sitemapEnabled"];

const pick = (row: Partial<ShopSeoSettings> | null): ShopSeoSettings => Object.fromEntries(KEYS.map((k) => [k, row?.[k] ?? DEFAULTS[k]])) as ShopSeoSettings;

async function readOf(db: PrismaClient | Prisma.TransactionClient, sellerId: string) {
  return pick(await db.shopSeo.findUnique({ where: { sellerId } }));
}

export async function readShopSeo(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  return readOf(db, ctx.sellerId);
}

// 공개 화면(사이트맵·메타 태그)이 부른다. 검색 노출을 끈 쇼핑몰은 indexingEnabled=false.
export const readShopSeoOf = readOf;

// 문자 값: null·빈 문자열 → null(지움), 통과 → 정리한 값, 위반 → undefined
function text(k: Key, v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (k === "googleVerification" || k === "naverVerification") {
    return typeof v === "string" && v.length <= SEO_VERIFICATION_MAX && VERIFICATION.test(v) ? v : undefined;
  }
  const isTitle = k === "searchTitle" || k === "productTitleTemplate";
  const clean = cleanText(v, isTitle ? SEO_TITLE_MAX : SEO_DESCRIPTION_MAX, "name");
  if (clean === null) return undefined;
  if ((k === "productTitleTemplate" || k === "productDescriptionTemplate") && [...clean.matchAll(/\{([^{}]*)\}|[{}]/g)].some((m) => m[1] === undefined || !PLACEHOLDERS.has(m[1]))) return undefined;
  return clean;
}

// 본문: 위 8개 키, 빼면 지금 값 유지. 모르는 키·잘못된 값·빈 본문이면 { ok: false }. 바뀐 값이 있을 때만 로그 추적에 남긴다.
export async function updateShopSeo(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false as const, reason: "invalid_shop_seo" as const };
  const b = raw as Record<string, unknown>;
  const given = Object.keys(b);
  if (given.length === 0 || given.some((k) => !(KEYS as string[]).includes(k))) return { ok: false as const, reason: "invalid_shop_seo" as const };
  const patch: Partial<ShopSeoSettings> = {};
  for (const k of given as Key[]) {
    if (BOOLS.includes(k)) {
      if (typeof b[k] !== "boolean") return { ok: false as const, reason: "invalid_shop_seo" as const };
      (patch as Record<string, unknown>)[k] = b[k];
    } else {
      const v = text(k, b[k]);
      if (v === undefined) return { ok: false as const, reason: "invalid_shop_seo" as const };
      (patch as Record<string, unknown>)[k] = v;
    }
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop_seo:${ctx.sellerId}`}))`;
    const before = await readOf(tx, ctx.sellerId);
    const after = { ...before, ...patch };
    await tx.shopSeo.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...after }, update: after });
    if (KEYS.some((k) => before[k] !== after[k])) {
      await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "shop.seo.update", targetType: "Seller", targetId: ctx.sellerId, before, after });
    }
    return { ok: true as const, seo: after };
  });
}
