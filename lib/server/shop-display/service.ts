import type { Prisma, PrismaClient, ShopDisplayKind } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { shopOpen } from "../buyers/signup";
import { productCode } from "../products/manage";
import { thumbnailUrls } from "../products/images";
import {
  SHOP_SORTS,
  arrange,
  defaultListSort,
  displayOptions,
  hallOfFameProductIds,
  liveProductIds,
  shopCardsInOrder,
  shopProductList,
  type ShopProductCard,
  type ShopSort,
} from "../products/shopCatalog";
import { cleanText } from "../text/clean";
import { requireSellerPermission, requireSellerRead, type TenantContext } from "../tenant/context";

// 상품 진열(SA-016, 2026-10-04 대표님 지시, PRODUCT_MANAGE).
// - 목록 기본 정렬 listSort: 구매자 상품 목록에서 정렬을 고르지 않았을 때(new·recommended·popular·low·high).
// - 홈 진열 영역: 추천 상품(RECOMMENDED)·신상품(NEW)·카테고리별(CATEGORY)·방송 상품(LIVE, 지금 방송에서 주문된 상품)·베스트(BEST, 최근 30일 결제 완료 판매량)·
//   할인 중(SALE, 이벤트 할인)·명예의 전당(HALL_OF_FAME, 지금 방송의 HIT 카드가 나온 상품. 방송·명예의 전당은 오버레이와 같은 기준) 영역을 최대 10개, 순서대로. 카테고리 말고는 종류마다 하나씩.
// - 진열 옵션(soldOutLast·hideSoldOut·liveFirst): 구매자 목록과 홈 진열 모두에 건다. 방송 상품 앞으로는 자동 정렬 목록만(추천 상품·방송 상품 영역은 정한 순서 그대로).
//   영역마다 제목(1~30자)·켜기·보일 상품 수(1~20). 저장은 통째로 바꾼다. 영역을 한 번도 저장하지 않았으면 기본(추천 8 → 신상품 8).
// - 추천 상품: 최대 20개, 순서대로. 지우지 않은 이 판매자 상품만. 구매자 화면에서는 보이는 상품(판매 중·품절)만 나온다.
// - 구매자 홈 GET /api/shop/{slug}/home: 켜진 영역만, 상품이 하나도 없는 영역은 뺀다. 카테고리 영역은 그 카테고리가 보일 때만(하위 포함, 진열 순서).
export const MAX_SECTIONS = 10;
export const MAX_RECOMMENDED = 20;
export const SECTION_TITLE_MAX = 30;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: readonly ShopDisplayKind[] = ["RECOMMENDED", "NEW", "CATEGORY", "LIVE", "BEST", "SALE", "HALL_OF_FAME"];
export const DEFAULT_SECTIONS = [
  { id: null, kind: "RECOMMENDED" as const, categoryId: null, title: "추천 상품", visible: true, itemCount: 8 },
  { id: null, kind: "NEW" as const, categoryId: null, title: "신상품", visible: true, itemCount: 8 },
];

type Section = { id: string | null; kind: ShopDisplayKind; categoryId: string | null; title: string; visible: boolean; itemCount: number };
type Tx = Prisma.TransactionClient;
const lock = (tx: Tx, sellerId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`shop_display:${sellerId}`}))`;
const fail = { ok: false as const, reason: "invalid_display_settings" as const };

async function sections(db: PrismaClient | Tx, sellerId: string): Promise<Section[]> {
  const rows = await db.shopDisplaySection.findMany({
    where: { sellerId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true, kind: true, categoryId: true, title: true, visible: true, itemCount: true },
  });
  return rows.length ? rows : DEFAULT_SECTIONS;
}

async function view(db: PrismaClient | Tx, sellerId: string) {
  const setting = await db.shopDisplaySetting.findUnique({ where: { sellerId }, select: { listSort: true, soldOutLast: true, hideSoldOut: true, liveFirst: true } });
  const items = await db.shopDisplayItem.findMany({
    where: { sellerId },
    orderBy: [{ sortOrder: "asc" }],
    select: { productId: true, product: { select: { codeNo: true, name: true, status: true, deletedAt: true } } },
  });
  const thumbs = await thumbnailUrls(db, sellerId, items.map((i) => i.productId));
  return {
    listSort: (setting?.listSort ?? "new") as ShopSort,
    options: { soldOutLast: setting?.soldOutLast ?? false, hideSoldOut: setting?.hideSoldOut ?? false, liveFirst: setting?.liveFirst ?? false },
    sections: await sections(db, sellerId),
    recommended: items.map((i) => ({
      productId: i.productId,
      code: productCode(i.product.codeNo),
      name: i.product.name,
      status: i.product.status,
      deleted: i.product.deletedAt !== null,
      thumbnailUrl: thumbs.get(i.productId) ?? null,
    })),
  };
}

export async function getDisplay(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "PRODUCT_MANAGE");
  return view(db, ctx.sellerId);
}

async function write<T>(db: PrismaClient, ctx: TenantContext, action: string, after: unknown, fn: (tx: Tx) => Promise<T | typeof fail>) {
  return db.$transaction(async (tx) => {
    await lock(tx, ctx.sellerId);
    const r = await fn(tx);
    if (r === fail) return fail;
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action, targetType: "Seller", targetId: ctx.sellerId, after });
    return { ok: true as const, value: await view(tx, ctx.sellerId) };
  });
}

const OPTION_KEYS = ["soldOutLast", "hideSoldOut", "liveFirst"] as const;

// 본문 { listSort?, soldOutLast?, hideSoldOut?, liveFirst? } 보낸 것만 바꾼다(하나 이상).
export async function setListSort(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const data: { listSort?: string; soldOutLast?: boolean; hideSoldOut?: boolean; liveFirst?: boolean } = {};
  if (b.listSort !== undefined) {
    if (!SHOP_SORTS.includes(b.listSort as ShopSort)) return fail;
    data.listSort = b.listSort as string;
  }
  for (const k of OPTION_KEYS) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") return fail;
    data[k] = b[k];
  }
  if (Object.keys(data).length === 0) return fail;
  return write(db, ctx, "shop_display.settings", data, async (tx) => {
    await tx.shopDisplaySetting.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: data });
  });
}

// 본문 { sections: [{ kind, categoryId?(CATEGORY만), title, visible?, itemCount? }] } 순서대로 통째로 바꾼다.
export async function setSections(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const list = raw && typeof raw === "object" ? (raw as Record<string, unknown>).sections : undefined;
  const parsed: Omit<Section, "id">[] = [];
  if (!Array.isArray(list) || list.length > MAX_SECTIONS) return fail;
  for (const item of list) {
    const b = item && typeof item === "object" ? (item as Record<string, unknown>) : null;
    const kind = b?.kind as ShopDisplayKind;
    const title = cleanText(b?.title, SECTION_TITLE_MAX);
    const visible = b?.visible ?? true;
    const itemCount = b?.itemCount ?? 8;
    const categoryId = b?.categoryId ?? null;
    if (!b || !KINDS.includes(kind) || !title || typeof visible !== "boolean" || !Number.isInteger(itemCount) || (itemCount as number) < 1 || (itemCount as number) > 20) {
      return fail;
    }
    if ((kind === "CATEGORY") !== (typeof categoryId === "string" && UUID.test(categoryId))) return fail;
    parsed.push({ kind, categoryId: kind === "CATEGORY" ? (categoryId as string).toLowerCase() : null, title, visible, itemCount: itemCount as number });
  }
  if (KINDS.some((k) => k !== "CATEGORY" && parsed.filter((s) => s.kind === k).length > 1)) {
    return fail;
  }
  return write(db, ctx, "shop_display.sections", { sections: parsed.map((s) => s.kind) }, async (tx) => {
    const cats = [...new Set(parsed.flatMap((s) => (s.categoryId ? [s.categoryId] : [])))];
    if (cats.length && (await tx.shopCategory.count({ where: { sellerId: ctx.sellerId, id: { in: cats } } })) !== cats.length) return fail;
    await tx.shopDisplaySection.deleteMany({ where: { sellerId: ctx.sellerId } });
    await tx.shopDisplaySection.createMany({ data: parsed.map((s, i) => ({ ...s, sellerId: ctx.sellerId, sortOrder: i })) });
  });
}

// 본문 { productIds: [...] } 최대 20개, 순서대로 통째로 바꾼다. 지우지 않은 이 판매자 상품만(하나라도 아니면 바꾸지 않음).
export async function setRecommended(db: PrismaClient, ctx: TenantContext, raw: unknown) {
  requireSellerPermission(ctx, "PRODUCT_MANAGE");
  const list = raw && typeof raw === "object" ? (raw as Record<string, unknown>).productIds : undefined;
  if (!Array.isArray(list) || list.length > MAX_RECOMMENDED || !list.every((v) => typeof v === "string" && UUID.test(v))) {
    return fail;
  }
  const ids = (list as string[]).map((v) => v.toLowerCase());
  if (new Set(ids).size !== ids.length) return fail;
  return write(db, ctx, "shop_display.recommended", { productIds: ids }, async (tx) => {
    if (ids.length && (await tx.product.count({ where: { sellerId: ctx.sellerId, id: { in: ids }, deletedAt: null } })) !== ids.length) return fail;
    await tx.shopDisplayItem.deleteMany({ where: { sellerId: ctx.sellerId } });
    await tx.shopDisplayItem.createMany({ data: ids.map((productId, i) => ({ sellerId: ctx.sellerId, productId, sortOrder: i })) });
  });
}

export type HomeSection = { kind: ShopDisplayKind; title: string; categoryId: string | null; products: ShopProductCard[] };

// 구매자 홈 진열. 운영 중이 아닌 쇼핑몰은 null(404).
export async function publicHome(db: PrismaClient, slug: string): Promise<{ sections: HomeSection[]; listSort: ShopSort } | null> {
  const shop = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, slug: true } });
  if (!shop || !(await shopOpen(db, shop.id))) return null;
  const out: HomeSection[] = [];
  const opts = await displayOptions(db, shop.id);
  const live = await liveProductIds(db, shop.id);
  // 정한 순서를 그대로 쓰는 영역(추천·방송·명예의 전당)은 방송 상품 앞으로를 걸지 않는다
  const fixed = (cards: ShopProductCard[], n: number) => arrange(cards, opts, null, (c) => c.id).slice(0, n);
  for (const s of (await sections(db, shop.id)).filter((x) => x.visible)) {
    let products: ShopProductCard[] = [];
    if (s.kind === "RECOMMENDED") {
      const items = await db.shopDisplayItem.findMany({ where: { sellerId: shop.id }, orderBy: [{ sortOrder: "asc" }], select: { productId: true } });
      products = fixed(await shopCardsInOrder(db, shop, items.map((i) => i.productId)), s.itemCount);
    } else if (s.kind === "LIVE") {
      products = fixed(await shopCardsInOrder(db, shop, live), s.itemCount);
    } else if (s.kind === "HALL_OF_FAME") {
      products = fixed(await shopCardsInOrder(db, shop, await hallOfFameProductIds(db, shop.id, s.itemCount)), s.itemCount);
    } else {
      const sort = s.kind === "NEW" ? "new" : s.kind === "BEST" ? "popular" : "recommended";
      const only = s.kind === "SALE" ? "sale" : s.kind === "BEST" ? "best" : undefined;
      const r = await shopProductList(db, shop.slug, { sort, categoryId: s.categoryId ?? undefined, limit: String(s.itemCount) }, only);
      products = r.ok ? r.value.products : []; // 보이지 않는 카테고리는 not_found → 영역을 뺀다
    }
    if (products.length) out.push({ kind: s.kind, title: s.title, categoryId: s.categoryId, products });
  }
  return { sections: out, listSort: await defaultListSort(db, shop.id) };
}
