import { type PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { ratio, type StatsRange } from "./range";
import { num, statsSnapshot } from "./sql";

// 찜→구매 근사(SALES_VIEW). 조회 기간에 찜한(WishItem.createdAt) 상품 가운데, 같은 회원이 그 찜 뒤에 그 상품을 결제한 비율을 본다.
// 찜을 해제하면 행이 지워져 과거 찜 기록을 알 수 없으므로 「지금도 찜 중인 것」만 센다 → 해제된 찜은 빠지는 근사치다(응답 approximate: true, 화면에 표기).
// 산 것 = 같은 회원의 결제 완료(status PAID, 환불·취소 제외) 주문 품목 중 그 상품이 있고 주문 시각이 찜 시각 이후인 것. 지운 상품은 뺀다.
// 상품별은 찜 많은 순 상위 10개(같으면 상품 id 순).
export const WISH_ROWS = 10;
type Total = { wishes: number; bought: number };
type Row = Total & { product_id: string; name: string };

export async function wishlistStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  return statsSnapshot(db, async (tx) => {
    const base = (sid: string) => tx.$queryRaw<Row[]>`
      SELECT p.id AS product_id, p.name, count(*)::int AS wishes,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" AND o."sellerId" = i."sellerId"
               WHERE i."sellerId" = w."sellerId" AND i."productId" = w."productId" AND o."buyerMemberId" = w."buyerMemberId"
                 AND o.status = 'PAID' AND o."createdAt" >= w."createdAt")
             )::int AS bought
      FROM "WishItem" w JOIN "Product" p ON p.id = w."productId" AND p."sellerId" = w."sellerId"
      WHERE w."sellerId" = ${sid}::uuid AND p."deletedAt" IS NULL AND w."createdAt" >= ${range.start} AND w."createdAt" < ${range.end}
      GROUP BY p.id, p.name`;
    const all = await base(ctx.sellerId);
    const total: Total = all.reduce((a, r) => ({ wishes: a.wishes + num(r.wishes), bought: a.bought + num(r.bought) }), { wishes: 0, bought: 0 });
    const top = [...all].sort((a, b) => b.wishes - a.wishes || (a.product_id < b.product_id ? -1 : 1)).slice(0, WISH_ROWS);
    return {
      range: { from: range.from, to: range.to },
      approximate: true,
      wishes: total.wishes,
      bought: total.bought,
      rate: ratio(total.bought, total.wishes),
      products: top.map((r) => ({ productId: r.product_id, name: r.name, wishes: num(r.wishes), bought: num(r.bought), rate: ratio(num(r.bought), num(r.wishes)) })),
    };
  });
}
