import type { PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import type { StatsRange } from "./range";
import { num } from "./sql";

// 방송 통계(SALES_VIEW). 그 기간(KST)에 시작한 방송별로, 주문대기에 올라간 주문(결제 때 올라감)을 센다.
// 한 주문의 여러 품목이 올라가도 주문은 한 번만 센다. 결제액은 그 주문들의 금액, 환불은 그 뒤 환불된 주문.
// 시청자 수·시청자 → 주문 전환은 데이터가 없어 내보내지 않는다(화면 「준비 중」).
export const BROADCAST_LIMIT = 100;

type Row = { id: string; title: string | null; status: string; started_at: Date; ended_at: Date | null; orders: number; paid: bigint; refunded: number; refund: bigint };

export async function broadcastStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  const sid = ctx.sellerId;
  const rows = await db.$queryRaw<Row[]>`
    WITH b AS (
      SELECT id, title, status::text AS status, "startedAt", "endedAt" FROM "BroadcastSession"
      WHERE "sellerId" = ${sid}::uuid AND "startedAt" >= ${range.start} AND "startedAt" < ${range.end}
    ),
    bo AS (
      SELECT DISTINCT q."broadcastSessionId" AS bid, q."orderId" AS oid FROM "QueueItem" q
      WHERE q."sellerId" = ${sid}::uuid AND q."broadcastSessionId" IN (SELECT id FROM b)
    )
    SELECT b.id, b.title, b.status, b."startedAt" AS started_at, b."endedAt" AS ended_at,
      count(o.id)::int AS orders,
      coalesce(sum(o."totalAmount"::bigint) FILTER (WHERE o."paidAt" IS NOT NULL), 0) AS paid,
      count(o.id) FILTER (WHERE o.status = 'REFUNDED')::int AS refunded,
      coalesce(sum(coalesce(o."refundAmount", o."totalAmount")::bigint) FILTER (WHERE o.status = 'REFUNDED'), 0) AS refund
    FROM b
    LEFT JOIN bo ON bo.bid = b.id
    LEFT JOIN "Order" o ON o.id = bo.oid AND o."sellerId" = ${sid}::uuid
    GROUP BY b.id, b.title, b.status, b."startedAt", b."endedAt"
    ORDER BY b."startedAt" DESC, b.id
    LIMIT ${BROADCAST_LIMIT}`;
  const list = rows.map((r) => {
    const paid = num(r.paid);
    const refund = num(r.refund);
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      startedAt: r.started_at.toISOString(),
      endedAt: r.ended_at?.toISOString() ?? null,
      orders: num(r.orders),
      paid,
      refunded: num(r.refunded),
      refund,
      net: paid - refund,
    };
  });
  return {
    range: { from: range.from, to: range.to, unit: range.unit },
    total: {
      broadcasts: list.length,
      orders: list.reduce((s, r) => s + r.orders, 0),
      paid: list.reduce((s, r) => s + r.paid, 0),
      net: list.reduce((s, r) => s + r.net, 0),
    },
    broadcasts: list,
    // 데이터가 없는 값(시청자 수·시청자 → 주문 전환)
    unavailable: ["viewers", "conversion"],
  };
}
