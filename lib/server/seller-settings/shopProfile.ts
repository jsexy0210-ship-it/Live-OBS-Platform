import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 쇼핑몰 정보(SA-060, SHOP_SETTINGS): 쇼핑몰 이름(필수 20자)·한 줄 소개(선택 40자)·운영 상태(OPEN 운영 중·PREPARING 준비 중·PAUSED 일시 정지)·
// 상단 공지(한 줄 60자)·홈 혜택 배너 보이기·이용안내/교환/환불 정책 글(1000자)·대표 주소(DEFAULT 기본 주소 / CUSTOM 내 도메인). 빼면 지금 값 유지. 주소(slug)는 바꾸지 않는다.
// 사업자·고객센터·채널 주소는 shop-legal-notice(SA-062)에 있다.
export const SHOP_NAME_MAX = 20;
export const SHOP_TAGLINE_MAX = 40;
export const TOP_NOTICE_MAX = 60;
export const USAGE_GUIDE_MAX = 1000;

export const OPERATING_STATES = ["OPEN", "PREPARING", "PAUSED"] as const;
export type OperatingState = (typeof OPERATING_STATES)[number];
export const PRIMARY_ADDRESS_KINDS = ["DEFAULT", "CUSTOM"] as const;
export type PrimaryAddressKind = (typeof PRIMARY_ADDRESS_KINDS)[number];

// primaryDomain: 소유 확인이 끝나고 정지되지 않은 내 도메인(가장 먼저 연결한 것). 없으면 null(대표 주소를 CUSTOM으로 둘 수 없다). 읽기 전용.
export type ShopProfile = {
  shopName: string;
  shopTagline: string | null;
  operatingState: OperatingState;
  topNotice: string | null;
  homeBenefitBannerVisible: boolean;
  usageGuide: string | null;
  primaryAddress: PrimaryAddressKind;
  primaryDomain: string | null;
};

export const SHOP_PROFILE_MESSAGES = {
  invalid_shop_profile: `쇼핑몰 이름은 ${SHOP_NAME_MAX}자 이내로 꼭 입력해 주십시오. 한 줄 소개는 ${SHOP_TAGLINE_MAX}자, 상단 공지는 ${TOP_NOTICE_MAX}자, 이용안내는 ${USAGE_GUIDE_MAX.toLocaleString("ko-KR")}자까지 쓸 수 있습니다. 운영 상태는 운영 중·준비 중·일시 정지 중 하나입니다`,
  no_verified_domain: "소유 확인이 끝난 내 도메인이 있어야 대표 주소로 쓸 수 있습니다",
} as const;
export type ShopProfileRejection = keyof typeof SHOP_PROFILE_MESSAGES;

const SELECT = { shopName: true, shopTagline: true, operatingState: true, shopTopNotice: true, homeBenefitBannerVisible: true, shopUsageGuide: true, primaryAddressKind: true } as const;
type Row = { shopName: string; shopTagline: string | null; operatingState: OperatingState; shopTopNotice: string | null; homeBenefitBannerVisible: boolean; shopUsageGuide: string | null; primaryAddressKind: PrimaryAddressKind };

async function verifiedDomain(db: Pick<PrismaClient, "sellerDomain">, sellerId: string): Promise<string | null> {
  const d = await db.sellerDomain.findFirst({ where: { sellerId, verifiedAt: { not: null }, suspendedAt: null }, orderBy: { createdAt: "asc" }, select: { hostname: true } });
  return d?.hostname ?? null;
}

const toProfile = (s: Row, primaryDomain: string | null): ShopProfile => ({
  shopName: s.shopName,
  shopTagline: s.shopTagline,
  operatingState: s.operatingState,
  topNotice: s.shopTopNotice,
  homeBenefitBannerVisible: s.homeBenefitBannerVisible,
  usageGuide: s.shopUsageGuide,
  primaryAddress: s.primaryAddressKind,
  primaryDomain,
});

export async function readShopProfile(db: PrismaClient, ctx: TenantContext): Promise<ShopProfile> {
  requireSellerRead(ctx, "SHOP_SETTINGS");
  const s = await db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: SELECT });
  return toProfile(s, await verifiedDomain(db, ctx.sellerId));
}

const EDITABLE = ["shopName", "shopTagline", "operatingState", "topNotice", "homeBenefitBannerVisible", "usageGuide", "primaryAddress"] as const;

// 비어 있으면(null·"") null(지움), 통과하면 정리한 값, 위반이면 undefined
function optionalText(v: unknown, max: number, kind: "name" | "multiline"): string | null | undefined {
  if (v === null || v === "") return null;
  return cleanText(v, max, kind) ?? undefined;
}

// 본문: 위 7개 키 중 보낸 것만 바꾼다(빈 본문·모르는 키는 거부). 이름은 비울 수 없고 나머지 글은 비우면 지운다. 대표 주소 CUSTOM은 소유 확인이 끝난 내 도메인이 있을 때만(없으면 no_verified_domain).
// 대표자·SHOP_SETTINGS만(그 밖 403), 바뀐 값이 있을 때만 로그 추적에 남긴다(이용안내 글은 글자 수만).
export async function updateShopProfile(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const bad = { ok: false as const, reason: "invalid_shop_profile" as const };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad;
  const b = raw as Record<string, unknown>;
  const given = Object.keys(b);
  if (given.length === 0 || given.some((k) => !(EDITABLE as readonly string[]).includes(k))) return bad;
  const data: Partial<Pick<Row, "shopName" | "shopTagline" | "operatingState" | "shopTopNotice" | "homeBenefitBannerVisible" | "shopUsageGuide" | "primaryAddressKind">> = {};
  if ("shopName" in b) {
    const n = cleanText(b.shopName, SHOP_NAME_MAX, "name");
    if (n === null) return bad;
    data.shopName = n;
  }
  if ("shopTagline" in b) {
    const t = optionalText(b.shopTagline, SHOP_TAGLINE_MAX, "name");
    if (t === undefined) return bad;
    data.shopTagline = t;
  }
  if ("operatingState" in b) {
    if (typeof b.operatingState !== "string" || !(OPERATING_STATES as readonly string[]).includes(b.operatingState)) return bad;
    data.operatingState = b.operatingState as OperatingState;
  }
  if ("topNotice" in b) {
    const t = optionalText(b.topNotice, TOP_NOTICE_MAX, "name");
    if (t === undefined) return bad;
    data.shopTopNotice = t;
  }
  if ("homeBenefitBannerVisible" in b) {
    if (typeof b.homeBenefitBannerVisible !== "boolean") return bad;
    data.homeBenefitBannerVisible = b.homeBenefitBannerVisible;
  }
  if ("usageGuide" in b) {
    const t = optionalText(b.usageGuide, USAGE_GUIDE_MAX, "multiline");
    if (t === undefined) return bad;
    data.shopUsageGuide = t;
  }
  if ("primaryAddress" in b) {
    if (typeof b.primaryAddress !== "string" || !(PRIMARY_ADDRESS_KINDS as readonly string[]).includes(b.primaryAddress)) return bad;
    data.primaryAddressKind = b.primaryAddress as PrimaryAddressKind;
  }
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop_profile:${ctx.sellerId}`}))`;
    const before = await tx.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: SELECT });
    const primaryDomain = await verifiedDomain(tx, ctx.sellerId);
    if (data.primaryAddressKind === "CUSTOM" && !primaryDomain) return { ok: false as const, reason: "no_verified_domain" as const };
    const changedKeys = (Object.keys(data) as (keyof typeof data)[]).filter((k) => before[k] !== data[k]);
    const after: Row = { ...before, ...data };
    if (changedKeys.length > 0) {
      await tx.seller.update({ where: { id: ctx.sellerId }, data: Object.fromEntries(changedKeys.map((k) => [k, data[k]])) });
      const log = (r: Row) => ({ ...r, shopUsageGuide: r.shopUsageGuide === null ? null : `${[...r.shopUsageGuide].length}자` });
      await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "shop.profile.update", targetType: "Seller", targetId: ctx.sellerId, before: log(before), after: log(after) });
    }
    return { ok: true as const, profile: toProfile(after, primaryDomain) };
  });
}

// 구매자 화면용(로그인 없음). 승인된(ACTIVE) 쇼핑몰만, 아니면 null. 이름·소개·상단 공지·혜택 배너·이용안내·운영 상태, 내 도메인을 대표 주소로 골랐고 소유 확인이 끝났으면 primaryDomain.
export async function publicShopProfile(db: PrismaClient, slug: string) {
  const s = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, status: true, ...SELECT } });
  if (!s || s.status !== "ACTIVE") return null;
  const [domain, policy] = await Promise.all([
    s.primaryAddressKind === "CUSTOM" ? verifiedDomain(db, s.id) : null,
    db.rewardPolicy.findUnique({ where: { sellerId: s.id }, select: { livePayoutEnabled: true } }),
  ]);
  // 적립금 실제 지급이 꺼져 있으면 구매자에게 적립 혜택을 알리지 않는다: 혜택 배너는 「파트너스가 켠 설정 AND 실제 지급 켜짐」일 때만 보인다.
  // 저장된 설정 값은 그대로 두어(파트너스용 응답은 설정 값) 실제 지급을 다시 켜면 원래대로 돌아온다.
  const rewardsEnabled = policy?.livePayoutEnabled === true;
  return {
    shopName: s.shopName,
    shopTagline: s.shopTagline,
    operatingState: s.operatingState,
    topNotice: s.shopTopNotice,
    homeBenefitBannerVisible: s.homeBenefitBannerVisible && rewardsEnabled,
    rewardsEnabled,
    usageGuide: s.shopUsageGuide,
    primaryDomain: domain,
  };
}
