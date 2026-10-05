import type { Prisma, PrismaClient } from "@prisma/client";
import { shopOpen } from "../buyers/signup";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from "../orders/create";
import { dbClock } from "../orders/overdue";
import { eventOf, orderUnitPrice } from "../products/event";
import { LOW_STOCK_MAX } from "../products/manage";

// 구매자 장바구니(SH-004, 로그인 회원만). 규칙:
// - 옵션마다 한 줄. 같은 옵션을 다시 담으면 수량을 더한다. 회원당 MAX_CART_ITEMS줄, 줄당 1~MAX_LINE_QUANTITY개(주문 한도와 같게).
// - 담기·수량 변경은 판매 중(ON_SALE) 상품의 지운 적 없는 옵션만, 재고 안에서만. 쇼핑몰이 잠기면 막는다(목록·삭제는 연다).
// - 가격·재고·판매 상태는 볼 때마다 지금 값으로 계산한다(이벤트 할인은 DB 시계로 판단, 주문과 같은 계산). 저장하는 것은 담을 때 보여 준 단가(addedUnitPrice) 하나뿐이고,
//   지금 단가와 다르면 priceChange로 알린다(표시용, 주문 금액에는 쓰지 않는다). 수량을 바꾸면 그때 보여 준 지금 단가로 새로 맞춘다.
// - 쓰기는 회원별 잠금(lockBuyerCart) 아래에서 회원이 아직 활성인지 다시 보고 한다. 탈퇴도 같은 잠금을 잡고 장바구니를 지운다.
// - 모든 조회·쓰기는 sellerId + buyerMemberId로 묶는다(다른 쇼핑몰·다른 회원 줄은 없는 것으로 본다).

type Db = PrismaClient | Prisma.TransactionClient;
type Tx = Prisma.TransactionClient;
export type CartScope = { sellerId: string; buyerMemberId: string };

export const MAX_CART_ITEMS = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 화면 문구(구매자 쇼핑몰: 해요체). 화면은 error 코드로 분기하고 message를 그대로 보여 준다.
export const CART_MESSAGES = {
  shop_unavailable: "지금은 쇼핑몰을 이용할 수 없어요",
  invalid_cart_item: "담을 상품과 수량을 다시 확인해 주세요",
  cart_item_not_found: "장바구니에서 상품을 찾을 수 없어요",
  product_unavailable: "지금은 살 수 없는 상품이에요",
  out_of_stock: "재고가 부족해요",
  quantity_limit: `한 상품은 ${MAX_LINE_QUANTITY}개까지 담을 수 있어요`,
  cart_full: `장바구니에는 ${MAX_CART_ITEMS}개 상품까지 담을 수 있어요`,
  checkout_empty: "주문할 상품을 골라 주세요",
  checkout_too_many: `한 번에 ${MAX_ORDER_LINES}개 상품까지 주문할 수 있어요`,
  checkout_unavailable: "지금은 주문할 수 없는 상품이 있어요. 장바구니를 확인해 주세요",
} as const;
export type CartFailure = keyof typeof CART_MESSAGES;
export const cartErrorBody = (reason: CartFailure) => ({ error: reason, message: CART_MESSAGES[reason] });
export const cartFailureStatus = (reason: CartFailure) =>
  reason === "shop_unavailable" ? 402 : reason === "cart_item_not_found" ? 404 : reason === "invalid_cart_item" || reason === "checkout_empty" || reason === "checkout_too_many" ? 400 : 409;

type Result<T> = { ok: true; value: T } | { ok: false; reason: CartFailure };

// 줄 상태: available(주문 가능) · not_enough_stock(재고보다 많이 담김) · sold_out(재고 0 또는 품절 상태) · unavailable(판매 중지·숨김·삭제)
export type CartLineStatus = "available" | "not_enough_stock" | "sold_out" | "unavailable";
export type CartLine = {
  id: string;
  productId: string;
  optionId: string;
  productName: string;
  optionName: string;
  quantity: number;
  unitPrice: number;
  listUnitPrice: number;
  lineTotal: number;
  stock: number;
  status: CartLineStatus;
  // 담은 뒤 단가가 바뀐 줄: from(담을 때)·to(지금)·diff(to − from)·direction. 안 바뀌었거나 이전 줄(담을 때 단가 없음)이면 null.
  priceChange: { from: number; to: number; diff: number; direction: "up" | "down" } | null;
  // 재고 표시: maxQuantity(지금 담을 수 있는 최대 수량, 살 수 없으면 0), shortage(재고보다 많이 담긴 수량, 없으면 0), stockLeft(재고가 적을 때만 남은 수, 아니면 null)
  maxQuantity: number;
  shortage: number;
  stockLeft: number | null;
};

export const lockBuyerCart = (tx: Tx, s: CartScope) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`buyer_cart:${s.sellerId}:${s.buyerMemberId}`}))`;

async function lockActive(tx: Tx, s: CartScope): Promise<boolean> {
  await lockBuyerCart(tx, s);
  return (await tx.buyerMember.count({ where: { id: s.buyerMemberId, sellerId: s.sellerId, status: "ACTIVE", deletedAt: null } })) === 1;
}

const isQuantity = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_LINE_QUANTITY;
const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

const lineSelect = {
  id: true,
  quantity: true,
  addedUnitPrice: true,
  option: {
    select: {
      id: true,
      name: true,
      priceDelta: true,
      stock: true,
      deletedAt: true,
      product: {
        select: { id: true, name: true, price: true, status: true, deletedAt: true, eventDiscountType: true, eventDiscountValue: true, eventStartsAt: true, eventEndsAt: true },
      },
    },
  },
} satisfies Prisma.CartItemSelect;
type Row = Prisma.CartItemGetPayload<{ select: typeof lineSelect }>;

function toLine(r: Row, now: Date): CartLine {
  const o = r.option;
  const p = o.product;
  const listUnitPrice = p.price + o.priceDelta;
  const unitPrice = orderUnitPrice(listUnitPrice, eventOf(p), now);
  const status: CartLineStatus =
    p.deletedAt || o.deletedAt || p.status === "DRAFT" || p.status === "HIDDEN"
      ? "unavailable"
      : p.status === "SOLD_OUT" || o.stock < 1
        ? "sold_out"
        : o.stock < r.quantity
          ? "not_enough_stock"
          : "available";
  const stock = Math.max(o.stock, 0);
  const sellable = status === "available" || status === "not_enough_stock";
  const priceChange = r.addedUnitPrice !== null && r.addedUnitPrice !== unitPrice ? { from: r.addedUnitPrice, to: unitPrice, diff: unitPrice - r.addedUnitPrice, direction: unitPrice > r.addedUnitPrice ? ("up" as const) : ("down" as const) } : null;
  return {
    id: r.id,
    productId: p.id,
    optionId: o.id,
    productName: p.name,
    optionName: o.name,
    quantity: r.quantity,
    unitPrice,
    listUnitPrice,
    lineTotal: unitPrice * r.quantity,
    stock,
    status,
    priceChange,
    maxQuantity: sellable ? Math.min(stock, MAX_LINE_QUANTITY) : 0,
    shortage: sellable ? Math.max(0, r.quantity - stock) : 0,
    stockLeft: sellable && stock <= LOW_STOCK_MAX ? stock : null,
  };
}

async function rows(db: Db, s: CartScope, ids?: string[]) {
  return db.cartItem.findMany({
    where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId, ...(ids ? { id: { in: ids } } : {}) },
    select: lineSelect,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

// 목록: 최근 담은 순. subtotal은 주문 가능한 줄(available)만 더한 상품 금액(배송비·쿠폰 제외, 주문서에서 계산).
export async function listCart(db: PrismaClient, s: CartScope) {
  const now = await dbClock(db);
  const items = (await rows(db, s)).map((r) => toLine(r, now));
  return { items, count: items.length, priceChangedCount: items.filter((i) => i.priceChange).length, subtotal: items.filter((i) => i.status === "available").reduce((sum, i) => sum + i.lineTotal, 0) };
}

// 머리 배지용 개수(담긴 줄 수)
export const countCart = (db: PrismaClient, s: CartScope) => db.cartItem.count({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId } });

// 담을 수 있는 옵션인지와 재고(같은 쇼핑몰, 지운 적 없는 옵션, 판매 중 상품)
async function sellableOption(tx: Tx, s: CartScope, optionId: string): Promise<Result<{ stock: number; unitPrice: number }>> {
  const o = await tx.productOption.findFirst({ where: { id: optionId, sellerId: s.sellerId }, select: { stock: true, priceDelta: true, deletedAt: true, product: { select: { status: true, deletedAt: true, price: true, eventDiscountType: true, eventDiscountValue: true, eventStartsAt: true, eventEndsAt: true } } } });
  if (!o || o.deletedAt || o.product.deletedAt || o.product.status === "DRAFT" || o.product.status === "HIDDEN") return { ok: false, reason: "product_unavailable" };
  if (o.product.status === "SOLD_OUT" || o.stock < 1) return { ok: false, reason: "out_of_stock" };
  return { ok: true, value: { stock: o.stock, unitPrice: orderUnitPrice(o.product.price + o.priceDelta, eventOf(o.product), await dbClock(tx)) } };
}

// 담기. 본문: { optionId, quantity }. 이미 담긴 옵션이면 수량을 더한다. 응답: 담은 줄 id와 담긴 줄 수.
export async function addToCart(db: PrismaClient, s: CartScope, input: { optionId?: unknown; quantity?: unknown }): Promise<Result<{ id: string; quantity: number; count: number }>> {
  const quantity = input.quantity === undefined ? 1 : input.quantity;
  if (!isId(input.optionId) || !isQuantity(quantity)) return { ok: false, reason: "invalid_cart_item" };
  const optionId = input.optionId;
  if (!(await shopOpen(db, s.sellerId))) return { ok: false, reason: "shop_unavailable" };
  return db.$transaction(async (tx): Promise<Result<{ id: string; quantity: number; count: number }>> => {
    if (!(await lockActive(tx, s))) return { ok: false, reason: "cart_item_not_found" };
    const option = await sellableOption(tx, s, optionId);
    if (!option.ok) return option;
    const existing = await tx.cartItem.findUnique({ where: { buyerMemberId_optionId: { buyerMemberId: s.buyerMemberId, optionId } }, select: { id: true, quantity: true } });
    const next = (existing?.quantity ?? 0) + quantity;
    if (next > MAX_LINE_QUANTITY) return { ok: false, reason: "quantity_limit" };
    if (next > option.value.stock) return { ok: false, reason: "out_of_stock" };
    let id: string;
    if (existing) {
      id = (await tx.cartItem.update({ where: { id: existing.id }, data: { quantity: next, addedUnitPrice: option.value.unitPrice }, select: { id: true } })).id;
    } else {
      if ((await tx.cartItem.count({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId } })) >= MAX_CART_ITEMS) return { ok: false, reason: "cart_full" };
      id = (await tx.cartItem.create({ data: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId, optionId, quantity: next, addedUnitPrice: option.value.unitPrice }, select: { id: true } })).id;
    }
    return { ok: true, value: { id, quantity: next, count: await tx.cartItem.count({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId } }) } };
  });
}

// 수량 바꾸기. 본문: { quantity }(1~99). 늘릴 때만 판매 상태·재고를 본다(줄이기는 품절이어도 된다).
export async function updateCartItem(db: PrismaClient, s: CartScope, itemId: string, input: { quantity?: unknown }): Promise<Result<{ id: string; quantity: number }>> {
  if (!isId(itemId)) return { ok: false, reason: "cart_item_not_found" };
  if (!isQuantity(input.quantity)) return { ok: false, reason: "invalid_cart_item" };
  const quantity = input.quantity;
  if (!(await shopOpen(db, s.sellerId))) return { ok: false, reason: "shop_unavailable" };
  return db.$transaction(async (tx): Promise<Result<{ id: string; quantity: number }>> => {
    if (!(await lockActive(tx, s))) return { ok: false, reason: "cart_item_not_found" };
    const item = await tx.cartItem.findFirst({ where: { id: itemId, sellerId: s.sellerId, buyerMemberId: s.buyerMemberId }, select: { id: true, quantity: true, optionId: true } });
    if (!item) return { ok: false, reason: "cart_item_not_found" };
    const option = await sellableOption(tx, s, item.optionId);
    if (quantity > item.quantity) {
      if (!option.ok) return option;
      if (quantity > option.value.stock) return { ok: false, reason: "out_of_stock" };
    }
    // 수량을 바꾼 때 보여 준 지금 단가로 비교 기준을 새로 맞춘다(살 수 없는 줄이면 그대로 둔다)
    await tx.cartItem.update({ where: { id: item.id }, data: { quantity, ...(option.ok ? { addedUnitPrice: option.value.unitPrice } : {}) } });
    return { ok: true, value: { id: item.id, quantity } };
  });
}

// 지우기: 한 줄(itemId) 또는 여러 줄(itemIds, 선택 삭제). 남의 줄·없는 줄은 건너뛴다. 응답: 지운 줄 수와 남은 줄 수.
export async function removeCartItems(db: PrismaClient, s: CartScope, itemIds: unknown): Promise<Result<{ removed: number; count: number }>> {
  if (!Array.isArray(itemIds) || itemIds.length === 0 || itemIds.length > MAX_CART_ITEMS || !itemIds.every(isId)) return { ok: false, reason: "invalid_cart_item" };
  return db.$transaction(async (tx) => {
    await lockBuyerCart(tx, s);
    const { count: removed } = await tx.cartItem.deleteMany({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId, id: { in: itemIds as string[] } } });
    return { ok: true as const, value: { removed, count: await tx.cartItem.count({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId } }) } };
  });
}

// 비우기(탈퇴·전체 삭제). 호출하는 쪽이 lockBuyerCart를 먼저 잡는다.
export const clearCart = (tx: Tx, s: CartScope) => tx.cartItem.deleteMany({ where: { sellerId: s.sellerId, buyerMemberId: s.buyerMemberId } });

// 주문서로 넘기기: 고른 줄(ids)이 모두 지금 주문 가능해야 한다. 응답 items는 주문 생성 API(POST /api/shop/[slug]/orders)의 items 그대로.
// 금액은 미리 보기이고 주문 때 서버가 다시 계산한다. 하나라도 안 되면 checkout_unavailable과 문제 줄(lines)을 준다.
export async function checkoutSelection(db: PrismaClient, s: CartScope, ids: string[]) {
  if (ids.length === 0) return { ok: false as const, reason: "checkout_empty" as const };
  if (ids.length > MAX_ORDER_LINES) return { ok: false as const, reason: "checkout_too_many" as const };
  if (!ids.every(isId) || new Set(ids).size !== ids.length) return { ok: false as const, reason: "invalid_cart_item" as const };
  if (!(await shopOpen(db, s.sellerId))) return { ok: false as const, reason: "shop_unavailable" as const };
  const now = await dbClock(db);
  const lines = (await rows(db, s, ids)).map((r) => toLine(r, now));
  if (lines.length !== ids.length) return { ok: false as const, reason: "cart_item_not_found" as const };
  const blocked = lines.filter((l) => l.status !== "available");
  if (blocked.length > 0) return { ok: false as const, reason: "checkout_unavailable" as const, lines: blocked };
  return {
    ok: true as const,
    value: { items: lines.map((l) => ({ optionId: l.optionId, quantity: l.quantity })), lines, subtotal: lines.reduce((sum, l) => sum + l.lineTotal, 0) },
  };
}
