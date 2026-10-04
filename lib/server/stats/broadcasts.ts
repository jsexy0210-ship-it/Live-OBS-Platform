import type { PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import type { StatsRange } from "./range";
import { num, statsSnapshot } from "./sql";

// 방송 통계(SALES_VIEW). 그 기간(KST)에 시작한 방송별로, 바뀌지 않는 주문 시각(Order.createdAt)으로 귀속한다(MASTER 결정 2026-10-04).
// - 방송 매출: 방송 [시작, 종료](방송 중이면 종료 = 지금) 안에 들어온 결제 주문
// - 방송 시간 일반 주문(별도 줄): 종료 뒤 2시간 안에 들어온 결제 주문
// 주문대기 항목의 broadcastSessionId는 방송 종료 때 지워지고 다음 방송에 다시 붙는 값이라 쓰지 않는다(지난 방송 매출이 바뀌지 않게).
// 방송은 겹치지 않아 한 주문은 한 방송에만 센다. 앞 방송의 「종료 뒤 2시간」과 다음 방송 시간이 겹치면 다음 방송의 방송 매출로 센다.
// 귀속은 조회 기간과 상관없이 정해진다(기간 밖 이웃 방송도 후보로 넣고, 결과만 기간 안 방송으로 거른다).
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
        SELECT id, title, status::text AS status, "startedAt", "endedAt", coalesce("endedAt", now()) AS end_at
        FROM "BroadcastSession"
        WHERE "sellerId" = ${sid}::uuid AND "startedAt" >= ${range.start} AND "startedAt" < ${range.end}
        ORDER BY "startedAt" DESC, id
        LIMIT ${BROADCAST_LIMIT}
      ),
      -- 귀속 후보는 조회 기간과 상관없이 정한다: 나열할 방송의 [시작, 종료 + 2시간]과 겹칠 수 있는 이웃 방송까지 넣어
      -- 먼저 귀속하고, 결과는 나열할 방송(b)만 남긴다. 그래야 기간 경계에서 다음 방송 중 주문이 앞 방송 일반 주문으로 새지 않는다.
      span AS (SELECT min("startedAt") AS lo, max(end_at) + ${AFTER_BROADCAST_WINDOW}::interval AS hi FROM b),
      cand AS (
        SELECT id, "startedAt", coalesce("endedAt", now()) AS end_at FROM "BroadcastSession", span
        WHERE "sellerId" = ${sid}::uuid AND "startedAt" < span.hi
          AND coalesce("endedAt", now()) + ${AFTER_BROADCAST_WINDOW}::interval > span.lo
      ),
      pick AS (
        SELECT DISTINCT ON (o.id) c.id AS bid, o."createdAt" <= c.end_at AS live,
          o."totalAmount", o.status, o."refundAmount"
        FROM "Order" o, span
        JOIN cand c ON TRUE
        WHERE o."sellerId" = ${sid}::uuid AND o."paidAt" IS NOT NULL
          AND o."createdAt" >= span.lo AND o."createdAt" < span.hi
          AND o."createdAt" >= c."startedAt" AND o."createdAt" < c.end_at + ${AFTER_BROADCAST_WINDOW}::interval
        ORDER BY o.id, (o."createdAt" <= c.end_at) DESC, c."startedAt" DESC, c.id
      ),
      agg AS (
        SELECT bid, live, count(*)::int AS orders, coalesce(sum("totalAmount"::bigint), 0) AS paid,
          count(*) FILTER (WHERE status = 'REFUNDED')::int AS refunded,
          coalesce(sum(coalesce("refundAmount", "totalAmount")::bigint) FILTER (WHERE status = 'REFUNDED'), 0) AS refund
        FROM pick WHERE bid IN (SELECT id FROM b) GROUP BY bid, live
      ),
      q AS (SELECT * FROM agg WHERE live),
      g AS (SELECT * FROM agg WHERE NOT live)
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
      // 방송 시간 일반 주문(종료 뒤 2시간 안에 들어온 결제 주문)
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
