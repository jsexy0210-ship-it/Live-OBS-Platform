import type { Prisma, PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { num } from "../stats/sql";

// 방송별 집계(SA-001 요약, 방송 상세·이력에서도 같은 함수). 귀속 규칙은 방송 통계(stats/broadcasts.ts)와 같다:
// 바뀌지 않는 시각으로 방송 [시작, 종료](방송 중이면 종료 = 지금)에 넣는다. 주문대기 항목의 broadcastSessionId는 방송이 끝나면
// 지워지는 값이라 쓰지 않는다. 방송은 겹치지 않으므로 한 주문·카드는 한 방송에만 들어간다.
// - orders: 방송 중 들어온 주문(결제 대기 포함, 모든 상태)
// - paidOrders·sales: 그중 결제된 주문 수와 결제액에서 환불액을 뺀 금액(통계 「순매출」과 같은 기준)
// - completed: 방송 중 개봉을 마친 주문대기 항목(doneAt) · cancelled: 방송 중 들어온 주문 가운데 지금 취소·환불된 주문
// - hits: 방송 중 만든 HIT 카드
type Db = PrismaClient | Prisma.TransactionClient;

export type BroadcastAggregate = { orders: number; paidOrders: number; sales: number; completed: number; cancelled: number; hits: number };
const EMPTY: BroadcastAggregate = { orders: 0, paidOrders: 0, sales: 0, completed: 0, cancelled: 0, hits: 0 };

type Row = { id: string; orders: number; paid_orders: number; sales: bigint; completed: number; cancelled: number; hits: number };

export async function aggregateBroadcasts(db: Db, sellerId: string, ids: string[]): Promise<Map<string, BroadcastAggregate>> {
  const out = new Map<string, BroadcastAggregate>();
  if (ids.length === 0) return out;
  const rows = await db.$queryRaw<Row[]>`
    WITH b AS (
      SELECT id, "startedAt" AS s, coalesce("endedAt", now()) AS e FROM "BroadcastSession"
      WHERE "sellerId" = ${sellerId}::uuid AND id = ANY(${ids}::uuid[])
    ),
    o AS (
      SELECT b.id,
        count(o.id)::int AS orders,
        count(o.id) FILTER (WHERE o."paidAt" IS NOT NULL)::int AS paid_orders,
        coalesce(sum(o."totalAmount"::bigint) FILTER (WHERE o."paidAt" IS NOT NULL), 0)
          - coalesce(sum(coalesce(o."refundAmount", o."totalAmount")::bigint) FILTER (WHERE o."paidAt" IS NOT NULL AND o.status = 'REFUNDED'), 0) AS sales,
        count(o.id) FILTER (WHERE o.status IN ('CANCELLED', 'REFUNDED'))::int AS cancelled
      FROM b LEFT JOIN "Order" o ON o."sellerId" = ${sellerId}::uuid AND o."createdAt" >= b.s AND o."createdAt" <= b.e
      GROUP BY b.id
    ),
    q AS (
      SELECT b.id, count(q.id)::int AS completed FROM b
      LEFT JOIN "QueueItem" q ON q."sellerId" = ${sellerId}::uuid AND q."doneAt" >= b.s AND q."doneAt" <= b.e
      GROUP BY b.id
    ),
    h AS (
      SELECT b.id, count(h.id)::int AS hits FROM b
      LEFT JOIN "HitCard" h ON h."sellerId" = ${sellerId}::uuid AND h."createdAt" >= b.s AND h."createdAt" <= b.e
      GROUP BY b.id
    )
    SELECT b.id, o.orders, o.paid_orders, o.sales, o.cancelled, q.completed, h.hits
    FROM b JOIN o ON o.id = b.id JOIN q ON q.id = b.id JOIN h ON h.id = b.id`;
  for (const r of rows) {
    out.set(r.id, { orders: num(r.orders), paidOrders: num(r.paid_orders), sales: num(r.sales), completed: num(r.completed), cancelled: num(r.cancelled), hits: num(r.hits) });
  }
  return out;
}

// 방송 대시보드 요약: 지금 방송(LIVE), 없으면 오늘(KST) 시작한 가장 최근 방송. 둘 다 없으면 broadcast: null과 0.
export async function broadcastSummary(db: PrismaClient, ctx: TenantContext) {
  requireSellerRead(ctx, "BROADCAST_RUN");
  const live = await db.broadcastSession.findFirst({ where: { sellerId: ctx.sellerId, status: "LIVE" }, orderBy: { startedAt: "desc" } });
  let session = live;
  if (!session) {
    const [today] = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM "BroadcastSession"
      WHERE "sellerId" = ${ctx.sellerId}::uuid AND ("startedAt" AT TIME ZONE 'Asia/Seoul')::date = (now() AT TIME ZONE 'Asia/Seoul')::date
      ORDER BY "startedAt" DESC, id DESC LIMIT 1`;
    session = today ? await db.broadcastSession.findFirst({ where: { id: today.id, sellerId: ctx.sellerId } }) : null;
  }
  if (!session) return { broadcast: null, summary: EMPTY };
  const agg = (await aggregateBroadcasts(db, ctx.sellerId, [session.id])).get(session.id) ?? EMPTY;
  return {
    broadcast: { id: session.id, title: session.title, status: session.status === "LIVE" ? ("live" as const) : ("ended" as const), startedAt: session.startedAt, endedAt: session.endedAt },
    summary: agg,
  };
}
