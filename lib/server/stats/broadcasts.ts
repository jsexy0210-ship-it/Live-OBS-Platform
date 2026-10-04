import type { PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import type { StatsRange } from "./range";
import { num, statsSnapshot } from "./sql";

// 방송 통계(SALES_VIEW). 그 기간(KST)에 시작한 방송별로 센다(MASTER 결정 2026-10-04).
// - 방송 매출(본값): 그 방송의 주문대기에 올라간 주문(결제 때 올라감). 한 주문의 여러 품목이 올라가도 주문은 한 번만 센다.
// - 방송 시간 일반 주문(별도 줄): 방송 시작 ~ 종료 뒤 2시간(방송 중이면 지금까지) 안에 들어온 결제 주문 중
//   어느 방송의 주문대기에도 올라가지 않은 주문. 겹치는 주문은 주문대기 쪽에서만 센다.
//   두 방송의 시간이 겹치면 그 주문 시각 직전에 시작한 방송 하나에만 넣는다.
// 결제액은 결제된 주문의 금액, 환불은 그 뒤 환불된 주문. 시청자 수·시청자 → 주문 전환은 데이터가 없어 내보내지 않는다(화면 「준비 중」).
export const BROADCAST_LIMIT = 100;
export const AFTER_BROADCAST_WINDOW = "2 hours";

type Agg = { orders: number; paid: bigint; refunded: number; refund: bigint };
type Row = { id: string; title: string | null; status: string; started_at: Date; ended_at: Date | null } & Agg & {
  g_orders: number;
  g_paid: bigint;
  g_refunded: number;
  g_refund: bigint;
};

const money = (orders: unknown, paid: unknown, refunded: unknown, refund: unknown) => {
  const p = num(paid);
  const r = num(refund);
  return { orders: num(orders), paid: p, refunded: num(refunded), refund: r, net: p - r };
};

export async function broadcastStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  const sid = ctx.sellerId;
  return statsSnapshot(db, async (tx) => {
    const rows = await tx.$queryRaw<Row[]>`
      WITH b AS (
        SELECT id, title, status::text AS status, "startedAt", "endedAt",
          coalesce("endedAt" + ${AFTER_BROADCAST_WINDOW}::interval, 'infinity'::timestamptz) AS window_end
        FROM "BroadcastSession"
        WHERE "sellerId" = ${sid}::uuid AND "startedAt" >= ${range.start} AND "startedAt" < ${range.end}
        ORDER BY "startedAt" DESC, id
        LIMIT ${BROADCAST_LIMIT}
      ),
      bo AS (
        SELECT DISTINCT q."broadcastSessionId" AS bid, q."orderId" AS oid FROM "QueueItem" q
        WHERE q."sellerId" = ${sid}::uuid AND q."broadcastSessionId" IN (SELECT id FROM b)
      ),
      q AS (
        SELECT bo.bid, count(o.id)::int AS orders,
          coalesce(sum(o."totalAmount"::bigint) FILTER (WHERE o."paidAt" IS NOT NULL), 0) AS paid,
          count(o.id) FILTER (WHERE o.status = 'REFUNDED')::int AS refunded,
          coalesce(sum(coalesce(o."refundAmount", o."totalAmount")::bigint) FILTER (WHERE o.status = 'REFUNDED'), 0) AS refund
        FROM bo JOIN "Order" o ON o.id = bo.oid AND o."sellerId" = ${sid}::uuid
        GROUP BY bo.bid
      ),
      g_pick AS (
        SELECT DISTINCT ON (o.id) b.id AS bid, o."totalAmount", o.status, o."refundAmount"
        FROM "Order" o
        JOIN b ON o."createdAt" >= b."startedAt" AND o."createdAt" < b.window_end
        WHERE o."sellerId" = ${sid}::uuid AND o."paidAt" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM "QueueItem" qi
            WHERE qi."sellerId" = ${sid}::uuid AND qi."orderId" = o.id AND qi."broadcastSessionId" IS NOT NULL
          )
        ORDER BY o.id, b."startedAt" DESC, b.id
      ),
      g AS (
        SELECT bid, count(*)::int AS orders, coalesce(sum("totalAmount"::bigint), 0) AS paid,
          count(*) FILTER (WHERE status = 'REFUNDED')::int AS refunded,
          coalesce(sum(coalesce("refundAmount", "totalAmount")::bigint) FILTER (WHERE status = 'REFUNDED'), 0) AS refund
        FROM g_pick GROUP BY bid
      )
      SELECT b.id, b.title, b.status, b."startedAt" AS started_at, b."endedAt" AS ended_at,
        coalesce(q.orders, 0) AS orders, coalesce(q.paid, 0) AS paid, coalesce(q.refunded, 0) AS refunded, coalesce(q.refund, 0) AS refund,
        coalesce(g.orders, 0) AS g_orders, coalesce(g.paid, 0) AS g_paid, coalesce(g.refunded, 0) AS g_refunded, coalesce(g.refund, 0) AS g_refund
      FROM b LEFT JOIN q ON q.bid = b.id LEFT JOIN g ON g.bid = b.id
      ORDER BY b."startedAt" DESC, b.id`;
    const list = rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      startedAt: r.started_at.toISOString(),
      endedAt: r.ended_at?.toISOString() ?? null,
      ...money(r.orders, r.paid, r.refunded, r.refund),
      // 방송 시간 일반 주문(주문대기에 올라가지 않은 결제 주문)
      general: money(r.g_orders, r.g_paid, r.g_refunded, r.g_refund),
    }));
    const sum = (pick: (r: (typeof list)[number]) => { orders: number; paid: number; net: number }) => ({
      orders: list.reduce((s, r) => s + pick(r).orders, 0),
      paid: list.reduce((s, r) => s + pick(r).paid, 0),
      net: list.reduce((s, r) => s + pick(r).net, 0),
    });
    return {
      range: { from: range.from, to: range.to, unit: range.unit },
      total: { broadcasts: list.length, ...sum((r) => r) },
      general: sum((r) => r.general),
      broadcasts: list,
      // 데이터가 없는 값(시청자 수·시청자 → 주문 전환)
      unavailable: ["viewers", "conversion"],
    };
  });
}
