import type { Prisma, PrismaClient } from "@prisma/client";
import { shopOpen } from "../buyers/signup";
import { dbClock } from "../orders/overdue";
import { eventOf, eventView, orderUnitPrice } from "../products/event";
import { liveProductIds } from "../products/shopCatalog";

// 구매자 찜(SH-034, 로그인 회원만). 규칙:
// - 상품마다 한 줄, 회원당 MAX_WISH_ITEMS개. 이미 찜한 상품을 다시 찜하면 그대로 성공(멱등).
// - 찜하기는 판매 중·품절 상품만(준비 중·숨김·삭제 상품은 안 됨). 쇼핑몰이 잠기면 막는다(목록·빼기는 연다).
// - 가격·판매 상태는 저장하지 않고 볼 때마다 지금 값. 가격은 상품 기본가(옵션 추가금 제외), 이벤트 할인은 DB 시계로 판단.
// - 쓰기는 회원별 잠금(lockBuyerWish) 아래에서 회원이 아직 활성인지 다시 보고 한다. 탈퇴도 같은 잠금을 잡고 찜을 지운다.
// - 모든 조회·쓰기는 sellerId + buyerMemberId로 묶는다.

type Tx = Prisma.TransactionClient;
export type WishScope = { sellerId: string; buyerMemberId: string };

export const MAX_WISH_ITEMS = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

// 화면 문구(구매자 쇼핑몰: 해요체)
export const WISH_MESSAGES = {
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없어요",
  invalid_wish_item: "찜할 상품을 다시 확인해 주세요",
  product_unavailable: "지금은 찜할 수 없는 상품이에요",
  wish_full: `찜은 ${MAX_WISH_ITEMS}개까지 할 수 있어요. 안 쓰는 찜을 지운 뒤 다시 해 주세요`,
  wish_item_not_found: "찜한 상품을 찾을 수 없어요",
} as const;
export type WishFailure = keyof typeof WISH_MESSAGES;
export const wishErrorBody = (reason: WishFailure) => ({ error: reason, message: WISH_MESSAGES[reason] });
export const wishFailureStatus = (reason: WishFailure) =>
  reason === "shop_unavailable" ? 402 : reason === "invalid_wish_item" ? 400 : reason === "wish_item_not_found" ? 404 : 409;

// 상품 상태: on_sale(살 수 있음) · sold_out(품절) · unavailable(판매 중지·숨김·삭제)
export type WishStatus = "on_sale" | "sold_out" | "unavailable";

export const lockBuyerWish = (tx: Tx, s: WishScope) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_wish:${s.sellerId}:${s.buyerMemberId}`}))`;

// 목록: 최근 찜한 순. 응답 { items: [{ productId, name, price, listPrice, status, wishedAt }], count }
export async function listWish(db: PrismaClient, s: WishScope) {
  const now = await dbClock(db);
  const rows = await db.wishItem.findMany({
    where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId },
    select: {
      createdAt: true,
      product: {
        select: {
          id: true,
          name: true,
          price: true,
          status: true,
          deletedAt: true,
          eventDiscountType: true,
          eventDiscountValue: true,
          eventStartsAt: true,
          eventEndsAt: true,
          options: { where: { deletedAt: null }, select: { stock: true } },
        },
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const liveIds = new Set(await liveProductIds(db, s.sellerId));
  const items = rows.map(({ product: p, createdAt }) => {
    const status: WishStatus =
      p.deletedAt || p.status === "DRAFT" || p.status === "HIDDEN" ? "unavailable" : p.status === "SOLD_OUT" || !p.options.some((o) => o.stock > 0) ? "sold_out" : "on_sale";
    const event = eventOf(p);
    const displayEvent = eventView(event, p.price, now);
    return { productId: p.id, name: p.name, price: orderUnitPrice(p.price, event, now), listPrice: p.price, status, wishedAt: createdAt, isLive: liveIds.has(p.id), eventBadge: displayEvent?.badge ?? null };
  });
  return { items, count: items.length };
}

// 찜한 상품 id만(상품 목록·상세의 하트 표시용). ?productIds=로 고르면 그중 찜한 것만.
export async function wishedProductIds(db: PrismaClient, s: WishScope, productIds?: string[]) {
  const rows = await db.wishItem.findMany({
    where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId, ...(productIds ? { productId: { in: productIds.filter(isId) } } : {}) },
    select: { productId: true },
  });
  return rows.map((r) => r.productId);
}

type Result<T> = { ok: true; value: T } | { ok: false; reason: WishFailure };

// 찜하기. 응답 created(새로 찜함)와 찜 개수.
export async function addWish(db: PrismaClient, s: WishScope, productId: unknown): Promise<Result<{ created: boolean; count: number }>> {
  if (!isId(productId)) return { ok: false, reason: "invalid_wish_item" };
  if (!(await shopOpen(db, s.sellerId))) return { ok: false, reason: "shop_unavailable" };
  return db.$transaction(async (tx): Promise<Result<{ created: boolean; count: number }>> => {
    await lockBuyerWish(tx, s);
    if ((await tx.buyerMember.count({ where: { id: s.buyerMemberId, sellerId: s.sellerId, status: "ACTIVE", deletedAt: null } })) !== 1) return { ok: false, reason: "wish_item_not_found" };
    const p = await tx.product.findFirst({ where: { id: productId, sellerId: s.sellerId, deletedAt: null, status: { in: ["ON_SALE", "SOLD_OUT"] } }, select: { id: true } });
    if (!p) return { ok: false, reason: "product_unavailable" };
    const where = { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId };
    const exists = await tx.wishItem.count({ where: { ...where, productId } });
    if (exists === 0) {
      if ((await tx.wishItem.count({ where })) >= MAX_WISH_ITEMS) return { ok: false, reason: "wish_full" };
      await tx.wishItem.create({ data: { ...where, productId } });
    }
    return { ok: true, value: { created: exists === 0, count: await tx.wishItem.count({ where }) } };
  });
}

// 빼기(상품 id로). 찜하지 않은 상품이면 removed: false.
export async function removeWish(db: PrismaClient, s: WishScope, productId: string): Promise<Result<{ removed: boolean; count: number }>> {
  if (!isId(productId)) return { ok: false, reason: "invalid_wish_item" };
  return db.$transaction(async (tx) => {
    await lockBuyerWish(tx, s);
    const where = { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId };
    const { count: removed } = await tx.wishItem.deleteMany({ where: { ...where, productId } });
    return { ok: true as const, value: { removed: removed > 0, count: await tx.wishItem.count({ where }) } };
  });
}

// 비우기(탈퇴). 호출하는 쪽이 lockBuyerWish를 먼저 잡는다.
export const clearWish = (tx: Tx, s: WishScope) => tx.wishItem.deleteMany({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId } });
