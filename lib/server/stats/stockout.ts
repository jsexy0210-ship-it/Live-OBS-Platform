import { type PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { kstDate } from "./range";
import { num, statsSnapshot } from "./sql";

// 재고 소진 속도(SALES_VIEW). 판매 중·품절 상품의 지우지 않은 옵션마다 「최근 N일 판매 수량」과 「지금 재고」로 하루 판매 속도와 예상 소진일을 준다.
// - 판매 수량 = 결제된 주문(paidAt 있음)의 품목 수량 − 환불한 수량. 기간은 N일 전 KST 0시부터 지금까지(오늘 포함), 주문 시각 기준.
// - 하루 판매 = 판매 수량 ÷ N일. 예상 소진일 = 지금 재고 ÷ 하루 판매(소수 첫째 자리). 판매가 없는 옵션은 속도를 알 수 없어 목록에서 뺀다.
// - 예상 소진일이 짧은 순(재고 0은 맨 앞, 같으면 하루 판매 많은 순). 목록은 상위 20개, atRisk는 전체에서 7일 안에 떨어질 옵션 수.
export const STOCKOUT_DAYS = [7, 14, 30] as const;
export const STOCKOUT_DEFAULT_DAYS = 14;
export const STOCKOUT_ROWS = 20;
export const STOCKOUT_RISK_DAYS = 7;
const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;

type Row = { option_id: string; product_id: string; product_name: string; option_name: string; stock: number; sold: bigint };

export async function stockoutStats(db: PrismaClient, ctx: TenantContext, days: number, now: Date = new Date()) {
  requireSellerRead(ctx, "SALES_VIEW");
  const todayStart = new Date(Math.floor((now.getTime() + KST_MS) / DAY_MS) * DAY_MS - KST_MS);
  const since = new Date(todayStart.getTime() - (days - 1) * DAY_MS);
  const rows = await statsSnapshot(db, (tx) =>
    tx.$queryRaw<Row[]>`
      SELECT o.id AS option_id, p.id AS product_id, p.name AS product_name, o.name AS option_name, o.stock,
             coalesce(sum(i.quantity - i."refundedQuantity"), 0) AS sold
      FROM "ProductOption" o
      JOIN "Product" p ON p.id = o."productId" AND p."sellerId" = o."sellerId"
      JOIN "OrderItem" i ON i."optionId" = o.id AND i."sellerId" = o."sellerId"
      JOIN "Order" r ON r.id = i."orderId" AND r."sellerId" = i."sellerId"
      WHERE o."sellerId" = ${ctx.sellerId}::uuid AND o."deletedAt" IS NULL AND p."deletedAt" IS NULL AND p.status IN ('ON_SALE', 'SOLD_OUT')
        AND r."paidAt" IS NOT NULL AND r."createdAt" >= ${since} AND r."createdAt" <= ${now}
      GROUP BY o.id, p.id, p.name, o.name, o.stock
      HAVING coalesce(sum(i.quantity - i."refundedQuantity"), 0) > 0`,
  );
  const items = rows
    .map((r) => {
      const sold = num(r.sold);
      const perDay = sold / days;
      return {
        optionId: r.option_id,
        productId: r.product_id,
        productName: r.product_name,
        optionName: r.option_name,
        stock: r.stock,
        sold,
        perDay: Math.round(perDay * 10) / 10,
        daysLeft: Math.round((r.stock / perDay) * 10) / 10,
      };
    })
    .sort((a, b) => a.daysLeft - b.daysLeft || b.perDay - a.perDay || (a.optionId < b.optionId ? -1 : 1));
  return {
    range: { days, from: kstDate(since), to: kstDate(todayStart) },
    atRisk: items.filter((r) => r.daysLeft <= STOCKOUT_RISK_DAYS).length,
    total: items.length,
    rows: items.slice(0, STOCKOUT_ROWS),
  };
}
