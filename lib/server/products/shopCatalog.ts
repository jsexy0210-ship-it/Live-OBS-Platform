import type { PrismaClient } from "@prisma/client";
import { dbNow } from "../billing/subscription";
import { shopOpen } from "../buyers/signup";
import { getShippingPolicy } from "../orders/shipping";
import type { RewardRates } from "../rewards/earn";
import { cleanText } from "../text/clean";
import { publicDetailBlocks } from "./detail";
import { eventOf, isEventActive, orderUnitPrice } from "./event";
import { shopImageUrl } from "./images";
import { LOW_STOCK_MAX, productCode } from "./manage";

// 구매자 쇼핑몰 상품 목록·상세(로그인 없이, MASTER 우선순위 2026-10-04). 운영 중인 쇼핑몰(shopOpen)의 보이는 상품(판매 중·품절, 지우지 않음)만.
// 가격은 지금(DB 시계) 걸린 이벤트 할인을 반영한 표시용이다. 실제 주문 금액은 주문 API가 다시 계산한다.
// 품절: 판매자가 품절로 바꿨거나 살아 있는 옵션 재고가 모두 0. 옵션 재고는 적을 때(1~5)만 남은 수를 알려 준다.
export const SHOP_SORTS = ["new", "recommended", "popular", "low", "high"] as const;
export type ShopSort = (typeof SHOP_SORTS)[number];
export const SHOP_PAGE_MAX = 60;
// 베스트 영역 판매량 기간(MASTER 결정 2026-10-05)
export const BEST_WINDOW_MS = 30 * 86_400_000;
const SHOP_PAGE_DEFAULT = 24;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISIBLE = ["ON_SALE", "SOLD_OUT"] as const;

export type ShopProductCard = {
  id: string;
  code: string;
  name: string;
  price: number;
  salePrice: number | null;
  soldOut: boolean;
  thumbnailUrl: string | null;
};

type ListFailure = "invalid_query" | "not_found";

async function openShop(db: PrismaClient, slug: string) {
  const shop = await db.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, slug: true } });
  return shop && (await shopOpen(db, shop.id)) ? shop : null;
}

// 보이는 카테고리면 그 카테고리와 (대분류면) 보이는 하위 카테고리 id. 아니면 null.
async function visibleCategoryIds(db: PrismaClient, sellerId: string, categoryId: string): Promise<string[] | null> {
  const c = await db.shopCategory.findFirst({ where: { id: categoryId, sellerId, visible: true }, select: { id: true, parent: { select: { visible: true } } } });
  if (!c || (c.parent && !c.parent.visible)) return null;
  const children = await db.shopCategory.findMany({ where: { sellerId, parentId: c.id, visible: true }, select: { id: true } });
  return [c.id, ...children.map((x) => x.id)];
}

const parseInt10 = (v: unknown, def: number, min: number, max: number) => {
  if (v === undefined || v === null || v === "") return def;
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

// 목록. ?categoryId(대분류는 하위 포함)·q(상품 이름, 50자)·sort(new 최근 등록 | recommended 판매자 진열 순서 | popular 판매량 | low·high 표시 가격)·page·limit(1~60)
// 응답 { products, total, page, hasMore }. 운영 중이 아닌 쇼핑몰·보이지 않는 카테고리는 not_found, 틀린 값은 invalid_query.
export async function shopProductList(
  db: PrismaClient,
  slug: string,
  q: { categoryId?: unknown; q?: unknown; sort?: unknown; page?: unknown; limit?: unknown },
  // 홈 진열 영역 전용(구매자 쿼리로는 받지 않음): sale = 이벤트 할인이 지금 걸린 상품만,
  // best = 최근 30일 결제 완료 판매량이 있는 상품만 판매량순(동률이면 최근 판매 순, 취소·환불 주문 제외)
  only?: "sale" | "best",
): Promise<{ ok: true; value: { products: ShopProductCard[]; total: number; page: number; hasMore: boolean } } | { ok: false; reason: ListFailure }> {
  const shop = await openShop(db, slug);
  if (!shop) return { ok: false, reason: "not_found" };
  // 정렬을 빼면 판매자가 정한 목록 기본 정렬(상품 진열 SA-016, 없으면 new)
  const sort = q.sort === undefined || q.sort === "" ? await defaultListSort(db, shop.id) : SHOP_SORTS.includes(q.sort as ShopSort) ? (q.sort as ShopSort) : null;
  const page = parseInt10(q.page, 1, 1, 10000);
  const limit = parseInt10(q.limit, SHOP_PAGE_DEFAULT, 1, SHOP_PAGE_MAX);
  const blankQ = q.q === undefined || (typeof q.q === "string" && /^ *$/.test(q.q));
  const term = blankQ ? null : cleanText(q.q, 50);
  if (!sort || page === null || limit === null || (!blankQ && term === null)) return { ok: false, reason: "invalid_query" };
  let categoryIds: string[] | null = null;
  if (q.categoryId !== undefined && q.categoryId !== "") {
    if (typeof q.categoryId !== "string" || !UUID.test(q.categoryId)) return { ok: false, reason: "invalid_query" };
    categoryIds = await visibleCategoryIds(db, shop.id, q.categoryId);
    if (!categoryIds) return { ok: false, reason: "not_found" };
  }
  const rows = await db.product.findMany({
    where: {
      sellerId: shop.id,
      deletedAt: null,
      status: { in: [...VISIBLE] },
      ...(term ? { name: { contains: term, mode: "insensitive" as const } } : {}),
      ...(categoryIds ? { categories: { some: { categoryId: { in: categoryIds } } } } : {}),
    },
    select: {
      id: true,
      codeNo: true,
      name: true,
      price: true,
      status: true,
      sortOrder: true,
      createdAt: true,
      eventDiscountType: true,
      eventDiscountValue: true,
      eventStartsAt: true,
      eventEndsAt: true,
      options: { where: { deletedAt: null }, select: { stock: true } },
    },
  });
  const now = await dbNow(db);
  const sold = new Map<string, number>();
  const lastSold = new Map<string, number>();
  if (only === "best" && rows.length) {
    const r = await db.$queryRaw<{ productId: string; sold: bigint; last: Date }[]>`
      SELECT oi."productId", SUM(oi."quantity")::bigint AS "sold", MAX(od."paidAt") AS "last" FROM "OrderItem" oi
      JOIN "Order" od ON od."sellerId" = oi."sellerId" AND od."id" = oi."orderId"
      WHERE oi."sellerId" = ${shop.id}::uuid AND od."status" = 'PAID' AND od."paidAt" >= ${new Date(now.getTime() - BEST_WINDOW_MS)}
      GROUP BY oi."productId"`;
    for (const x of r) {
      sold.set(x.productId, Number(x.sold));
      lastSold.set(x.productId, x.last.getTime());
    }
  } else if (sort === "popular" && rows.length) {
    const r = await db.$queryRaw<{ productId: string; sold: bigint }[]>`
      SELECT oi."productId", SUM(oi."quantity")::bigint AS "sold" FROM "OrderItem" oi
      JOIN "Order" od ON od."sellerId" = oi."sellerId" AND od."id" = oi."orderId"
      WHERE oi."sellerId" = ${shop.id}::uuid AND od."status" = 'PAID' GROUP BY oi."productId"`;
    for (const x of r) sold.set(x.productId, Number(x.sold));
  }
  const allCards = rows.map((p) => {
    const shown = orderUnitPrice(p.price, eventOf(p), now);
    return { p, shown, salePrice: shown < p.price ? shown : null, soldOut: p.status === "SOLD_OUT" || p.options.every((o) => o.stock <= 0) };
  });
  const cards = only === "sale" ? allCards.filter((c) => c.salePrice !== null) : only === "best" ? allCards.filter((c) => sold.has(c.p.id)) : allCards;
  // 카테고리를 고르고 진열 순서(recommended)로 보면 카테고리 안 진열 순서가 먼저: 고른 카테고리에 직접 지정한 상품 → 하위 카테고리(카테고리 순서대로)
  const catRank = new Map<string, number>();
  if (categoryIds && sort === "recommended" && rows.length) {
    const links = await db.productCategory.findMany({
      where: { sellerId: shop.id, categoryId: { in: categoryIds }, productId: { in: rows.map((r) => r.id) } },
      select: { productId: true, categoryId: true, sortOrder: true, category: { select: { sortOrder: true, parentId: true } } },
    });
    for (const l of links) {
      const rank = (l.category.parentId === null || l.categoryId === categoryIds[0] ? 0 : (l.category.sortOrder + 1) * 1_000_000) + l.sortOrder;
      catRank.set(l.productId, Math.min(catRank.get(l.productId) ?? Infinity, rank));
    }
  }
  const byId = (a: { p: { id: string } }, b: { p: { id: string } }) => (a.p.id < b.p.id ? -1 : 1);
  const cmp: Record<ShopSort, (a: (typeof cards)[number], b: (typeof cards)[number]) => number> = {
    new: (a, b) => b.p.createdAt.getTime() - a.p.createdAt.getTime() || byId(a, b),
    recommended: (a, b) => (catRank.get(a.p.id) ?? 0) - (catRank.get(b.p.id) ?? 0) || a.p.sortOrder - b.p.sortOrder || b.p.createdAt.getTime() - a.p.createdAt.getTime() || byId(a, b),
    popular: (a, b) => (sold.get(b.p.id) ?? 0) - (sold.get(a.p.id) ?? 0) || b.p.createdAt.getTime() - a.p.createdAt.getTime() || byId(a, b),
    low: (a, b) => a.shown - b.shown || byId(a, b),
    high: (a, b) => b.shown - a.shown || byId(a, b),
  };
  cards.sort(only === "best" ? (a, b) => sold.get(b.p.id)! - sold.get(a.p.id)! || lastSold.get(b.p.id)! - lastSold.get(a.p.id)! || byId(a, b) : cmp[sort]);
  const arranged = arrange(cards, await displayOptions(db, shop.id), await liveProductIds(db, shop.id), (c) => c.p.id);
  const slice = arranged.slice((page - 1) * limit, page * limit);
  const thumbs = await thumbnails(db, shop.id, shop.slug, slice.map((c) => c.p.id));
  return {
    ok: true,
    value: {
      products: slice.map(({ p, salePrice, soldOut }) => ({
        id: p.id,
        code: productCode(p.codeNo),
        name: p.name,
        price: p.price,
        salePrice,
        soldOut,
        thumbnailUrl: thumbs.get(p.id) ?? null,
      })),
      total: arranged.length,
      page,
      hasMore: page * limit < arranged.length,
    },
  };
}

export type DisplayOptions = { soldOutLast: boolean; hideSoldOut: boolean; liveFirst: boolean };
const NO_OPTIONS: DisplayOptions = { soldOutLast: false, hideSoldOut: false, liveFirst: false };

// 진열 옵션(SA-016): 품절 맨 뒤로·품절 숨기기·방송 상품 앞으로. 설정이 없으면 모두 꺼짐.
export async function displayOptions(db: PrismaClient, sellerId: string): Promise<DisplayOptions> {
  const row = await db.shopDisplaySetting.findUnique({ where: { sellerId }, select: { soldOutLast: true, hideSoldOut: true, liveFirst: true } });
  return row ?? NO_OPTIONS;
}

// 지금 방송(LIVE) 중이면 그 방송에서 주문된 상품 id(가장 최근 주문 순, 중복 없음, 취소된 대기열 제외). 방송 중이 아니면 빈 목록.
// 오버레이(lib/server/overlay/state.ts)의 지금 방송·주문 기준과 같다.
export async function liveProductIds(db: PrismaClient, sellerId: string): Promise<string[]> {
  const live = await db.broadcastSession.findFirst({ where: { sellerId, status: "LIVE" }, orderBy: { startedAt: "desc" }, select: { id: true } });
  if (!live) return [];
  const rows = await db.$queryRaw<{ productId: string }[]>`
    SELECT oi."productId" FROM "QueueItem" q
    JOIN "OrderItem" oi ON oi."sellerId" = q."sellerId" AND oi."id" = q."orderItemId"
    WHERE q."sellerId" = ${sellerId}::uuid AND q."broadcastSessionId" = ${live.id}::uuid AND q."status" <> 'CANCELLED'
    GROUP BY oi."productId" ORDER BY MAX(q."receivedAt") DESC, oi."productId"`;
  return rows.map((r) => r.productId);
}

// 명예의 전당 영역: 지금 방송(LIVE)의 HIT 카드가 나온 상품 id(가장 최근 HIT 순, 중복 없음). 방송 중이 아니면 빈 목록.
// 오버레이 명예의 전당(지금 방송의 HIT 카드, lib/server/overlay/state.ts)과 같은 기준.
export async function hallOfFameProductIds(db: PrismaClient, sellerId: string, limit: number): Promise<string[]> {
  const live = await db.broadcastSession.findFirst({ where: { sellerId, status: "LIVE" }, orderBy: { startedAt: "desc" }, select: { id: true } });
  if (!live) return [];
  const rows = await db.$queryRaw<{ productId: string }[]>`
    SELECT oi."productId" FROM "HitCard" h
    JOIN "QueueItem" q ON q."sellerId" = h."sellerId" AND q."id" = h."queueItemId"
    JOIN "OrderItem" oi ON oi."sellerId" = q."sellerId" AND oi."id" = q."orderItemId"
    WHERE h."sellerId" = ${sellerId}::uuid AND h."broadcastSessionId" = ${live.id}::uuid
    GROUP BY oi."productId" ORDER BY MAX(h."createdAt") DESC, oi."productId" LIMIT ${limit * 3}`;
  return rows.map((r) => r.productId);
}

// 정렬된 목록에 진열 옵션을 건다(순서는 그대로 두고 옮기기만). 품절 숨기기 → 방송 상품 앞으로(liveIds가 있을 때) → 품절 맨 뒤로.
// 품절 맨 뒤로가 마지막이라 품절된 방송 상품도 맨 뒤로 간다.
export function arrange<T extends { soldOut: boolean }>(list: T[], o: DisplayOptions, liveIds: string[] | null, idOf: (x: T) => string): T[] {
  let out = o.hideSoldOut ? list.filter((x) => !x.soldOut) : list;
  if (o.liveFirst && liveIds?.length) {
    const live = new Set(liveIds);
    out = [...out.filter((x) => live.has(idOf(x))), ...out.filter((x) => !live.has(idOf(x)))];
  }
  if (o.soldOutLast) out = [...out.filter((x) => !x.soldOut), ...out.filter((x) => x.soldOut)];
  return out;
}

export async function defaultListSort(db: PrismaClient, sellerId: string): Promise<ShopSort> {
  const row = await db.shopDisplaySetting.findUnique({ where: { sellerId }, select: { listSort: true } });
  return SHOP_SORTS.includes(row?.listSort as ShopSort) ? (row!.listSort as ShopSort) : "new";
}

// 주어진 순서대로 보이는 상품만 상품 카드로(추천 상품 진열). 지웠거나 보이지 않는 상품은 빠진다.
export async function shopCardsInOrder(db: PrismaClient, shop: { id: string; slug: string }, ids: string[]): Promise<ShopProductCard[]> {
  if (!ids.length) return [];
  const rows = await db.product.findMany({
    where: { sellerId: shop.id, id: { in: ids }, deletedAt: null, status: { in: [...VISIBLE] } },
    select: {
      id: true,
      codeNo: true,
      name: true,
      price: true,
      status: true,
      eventDiscountType: true,
      eventDiscountValue: true,
      eventStartsAt: true,
      eventEndsAt: true,
      options: { where: { deletedAt: null }, select: { stock: true } },
    },
  });
  const now = await dbNow(db);
  const thumbs = await thumbnails(db, shop.id, shop.slug, rows.map((r) => r.id));
  const byId = new Map(rows.map((p) => [p.id, p]));
  return ids.flatMap((id) => {
    const p = byId.get(id);
    if (!p) return [];
    const shown = orderUnitPrice(p.price, eventOf(p), now);
    return [
      {
        id: p.id,
        code: productCode(p.codeNo),
        name: p.name,
        price: p.price,
        salePrice: shown < p.price ? shown : null,
        soldOut: p.status === "SOLD_OUT" || p.options.every((o) => o.stock <= 0),
        thumbnailUrl: thumbs.get(p.id) ?? null,
      },
    ];
  });
}

async function thumbnails(db: PrismaClient, sellerId: string, slug: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const rows = await db.$queryRaw<{ id: string; productId: string; sha256: string }[]>`
    SELECT DISTINCT ON (i."productId") i."id", i."productId", i."sha256" FROM "ProductImage" i
    WHERE i."sellerId" = ${sellerId}::uuid AND i."productId" = ANY(${ids}::uuid[]) AND i."kind" = 'GALLERY'
    ORDER BY i."productId", i."sortOrder", i."createdAt", i."id"`;
  return new Map(rows.map((r) => [r.productId, shopImageUrl(slug, r)]));
}

// 상세. buyerGradeId가 있으면(로그인 회원) 그 등급, 없으면 가입 때 받는 기본 등급(가장 앞 등급)의 적립률로 적립 예정액을 보인다.
// 적립 예정액은 표시 가격 기준 원 단위 내림 미리보기다(쿠폰·옵션 추가금·결제 수단에 따라 실제 적립액은 결제 때 정해진다).
export async function shopProductDetail(db: PrismaClient, slug: string, productId: string, buyerGradeId?: string | null) {
  if (!UUID.test(productId)) return null;
  const shop = await openShop(db, slug);
  if (!shop) return null;
  const p = await db.product.findFirst({
    where: { id: productId, sellerId: shop.id, deletedAt: null, status: { in: [...VISIBLE] } },
    include: {
      options: { where: { deletedAt: null }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
      images: { where: { kind: "GALLERY" }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
      categories: { include: { category: { select: { id: true, name: true, visible: true, sortOrder: true, parent: { select: { visible: true, sortOrder: true } } } } } },
    },
  });
  if (!p) return null;
  const now = await dbNow(db);
  const event = eventOf(p);
  const active = isEventActive(event, now);
  const shown = orderUnitPrice(p.price, event, now);
  const productSoldOut = p.status === "SOLD_OUT";
  const shipping = await getShippingPolicy(db, shop.id);
  return {
    id: p.id,
    code: productCode(p.codeNo),
    name: p.name,
    description: p.description,
    price: p.price,
    salePrice: shown < p.price ? shown : null,
    event: active ? { endsAt: event.endsAt } : null,
    soldOut: productSoldOut || p.options.every((o) => o.stock <= 0),
    images: p.images.map((i) => ({ id: i.id, url: shopImageUrl(shop.slug, i), width: i.width, height: i.height })),
    options: p.options.map((o) => {
      const unit = p.price + o.priceDelta;
      const sale = orderUnitPrice(unit, event, now);
      const soldOut = productSoldOut || o.stock <= 0;
      return { id: o.id, name: o.name, price: unit, salePrice: sale < unit ? sale : null, soldOut, stockLeft: !soldOut && o.stock <= LOW_STOCK_MAX ? o.stock : null };
    }),
    detail: await publicDetailBlocks(db, shop.id, shop.slug, p.id),
    categories: p.categories
      .map((c) => c.category)
      .filter((c) => c.visible && (!c.parent || c.parent.visible))
      .sort((a, b) => (a.parent?.sortOrder ?? a.sortOrder) - (b.parent?.sortOrder ?? b.sortOrder) || a.sortOrder - b.sortOrder)
      .map(({ id, name }) => ({ id, name })),
    shipping: { freeShipping: shipping.freeShipping, baseFee: shipping.baseFee, freeOverAmount: shipping.freeOverAmount, remoteSurcharge: shipping.remoteSurcharge },
    reward: await rewardPreview(db, shop.id, buyerGradeId ?? null, shown, now),
  };
}

async function rewardPreview(db: PrismaClient, sellerId: string, buyerGradeId: string | null, base: number, now: Date) {
  const policy = await db.rewardPolicy.findUnique({ where: { sellerId }, select: { rates: true, earnStartsAt: true } });
  if (!policy || (policy.earnStartsAt && policy.earnStartsAt > now)) return null;
  const gradeId =
    buyerGradeId ?? (await db.memberGrade.findFirst({ where: { sellerId }, orderBy: [{ sortOrder: "asc" }], select: { id: true } }))?.id ?? null;
  if (!gradeId) return null;
  const r = ((policy.rates && typeof policy.rates === "object" ? policy.rates : {}) as RewardRates)[gradeId];
  const one = (rate: unknown) => (typeof rate === "number" && Number.isFinite(rate) && rate > 0 && rate <= 100 ? { rate, amount: Math.floor((base * rate) / 100) } : null);
  const card = one(r?.card);
  const bankTransfer = one(r?.bankTransfer);
  return card || bankTransfer ? { card, bankTransfer } : null;
}
