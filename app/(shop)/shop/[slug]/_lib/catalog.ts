import type { ProductCardData } from "../../../../../components/shop/ProductCard";
import { prisma } from "../../../../../lib/server/db";
import { discountedUnit, eventOf, isEventActive } from "../../../../../lib/server/products/event";

// 구매자에게 보이는 상품(판매 중·품절, 지우지 않은 것)을 상품 카드 값으로 읽는다. 쇼핑몰 주인(sellerId) 것만.
// 가격은 상품 기본가에 지금(서버 시계) 걸린 이벤트 할인을 반영한 표시용 값이다. 주문 금액은 주문 API가 다시 계산한다.
// 품절: 판매자가 품절로 바꿨거나, 남은 옵션 재고가 모두 0이다.
export const SORTS = { new: "신상품", low: "낮은 가격", high: "높은 가격" } as const;
export type SortKey = keyof typeof SORTS;
export const sortKey = (v: string | undefined): SortKey => (v === "low" || v === "high" ? v : "new");

export async function shopProducts(sellerId: string, opts: { q?: string; sort?: SortKey } = {}): Promise<ProductCardData[]> {
  const now = new Date();
  const rows = await prisma.product.findMany({
    where: {
      sellerId,
      deletedAt: null,
      status: { in: ["ON_SALE", "SOLD_OUT"] },
      ...(opts.q ? { name: { contains: opts.q, mode: "insensitive" as const } } : {}),
    },
    select: {
      id: true,
      name: true,
      price: true,
      status: true,
      createdAt: true,
      eventDiscountType: true,
      eventDiscountValue: true,
      eventStartsAt: true,
      eventEndsAt: true,
      options: { where: { deletedAt: null }, select: { stock: true } },
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }],
  });
  const cards = rows.map((p) => {
    const e = eventOf(p);
    const sale = isEventActive(e, now) ? discountedUnit(p.price, e) : null;
    return {
      id: p.id,
      name: p.name,
      price: p.price,
      salePrice: sale !== null && sale < p.price ? sale : null,
      soldOut: p.status === "SOLD_OUT" || p.options.every((o) => o.stock <= 0),
      createdAt: p.createdAt.getTime(),
    };
  });
  const shown = (c: (typeof cards)[number]) => c.salePrice ?? c.price;
  if (opts.sort === "new") cards.sort((a, b) => b.createdAt - a.createdAt);
  if (opts.sort === "low") cards.sort((a, b) => shown(a) - shown(b));
  if (opts.sort === "high") cards.sort((a, b) => shown(b) - shown(a));
  return cards.map((c) => ({ id: c.id, name: c.name, price: c.price, salePrice: c.salePrice, soldOut: c.soldOut }));
}
