import type { PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { AFTER_BROADCAST_WINDOW, broadcastStatsIn } from "./broadcasts";
import { memberStatsIn } from "./members";
import { orderStatsIn } from "./orders";
import { productStatsIn } from "./products";
import { ratio, type StatsRange } from "./range";
import { num, statsSnapshot, type StatsDb } from "./sql";

// 통계 요약(SA-056, SALES_VIEW). 주문·상품·회원·방송 통계와 아래 지표를 한 스냅숏으로 읽는다. 날짜 기준은 주문 시각(KST).
// - 신규 vs 기존 매출: 기간 안 결제 주문의 순매출(결제액 − 환불액)을, 그 회원의 첫 결제 주문이 기간 안이면 신규, 앞이면 기존으로 나눈다
// - 적립금: 기간 안에 처리된(SUCCEEDED) 원장. 지급 = 적립·랭킹 보너스, 회수 = 적립 회수, 사용 = 주문 사용, 소멸 = 소멸
// - 결제 → 발송 평균: 기간 안 주문 중 발송한 주문의 (발송 시각 − 결제 시각) 평균
// - 미입금 자동 취소: 기간 안 주문 중 입금 기한이 지나 시스템이 취소한 주문
// - 방송 외 주문: 기간 안 결제 주문 중 어느 방송의 [시작, 종료 + 2시간]에도 들지 않는 주문
// 방문자·쿠폰·교환·반품·문의 답변·리뷰·회원 등급별은 데이터가 없어 내보내지 않는다(화면 「준비 중」).

type Extra = {
  new_net: bigint;
  old_net: bigint;
  reward_earn: bigint;
  reward_revoke: bigint;
  reward_use: bigint;
  reward_expire: bigint;
  ship_count: number;
  ship_avg_sec: number | null;
  auto_cancelled: number;
  outside_orders: number;
  outside_net: bigint;
};

async function extras(tx: StatsDb, sid: string, start: Date, end: Date) {
  const [r] = await tx.$queryRaw<Extra[]>`
    WITH o AS (
      SELECT id, "buyerMemberId", "createdAt", "totalAmount"::bigint - CASE WHEN status = 'REFUNDED' THEN coalesce("refundAmount", "totalAmount") ELSE 0 END AS net
      FROM "Order"
      WHERE "sellerId" = ${sid}::uuid AND "paidAt" IS NOT NULL AND "createdAt" >= ${start} AND "createdAt" < ${end}
    ),
    first AS (
      SELECT "buyerMemberId", min("createdAt") AS f FROM "Order"
      WHERE "sellerId" = ${sid}::uuid AND "paidAt" IS NOT NULL AND "buyerMemberId" IN (SELECT "buyerMemberId" FROM o)
      GROUP BY 1
    ),
    nv AS (
      SELECT coalesce(sum(o.net) FILTER (WHERE first.f >= ${start}), 0) AS new_net,
        coalesce(sum(o.net) FILTER (WHERE first.f < ${start}), 0) AS old_net
      FROM o JOIN first USING ("buyerMemberId")
    ),
    rw AS (
      SELECT
        coalesce(sum(amount) FILTER (WHERE type IN ('EARN', 'RANKING_BONUS')), 0)::bigint AS reward_earn,
        coalesce(sum(-amount) FILTER (WHERE type = 'REVOKE'), 0)::bigint AS reward_revoke,
        coalesce(sum(-amount) FILTER (WHERE type = 'USE'), 0)::bigint AS reward_use,
        coalesce(sum(-amount) FILTER (WHERE type = 'EXPIRE'), 0)::bigint AS reward_expire
      FROM "RewardLedger"
      WHERE "sellerId" = ${sid}::uuid AND status = 'SUCCEEDED' AND "createdAt" >= ${start} AND "createdAt" < ${end}
    ),
    sh AS (
      SELECT count(*)::int AS ship_count, avg(extract(epoch FROM s."shippedAt" - od."paidAt"))::float8 AS ship_avg_sec
      FROM "Shipment" s JOIN "Order" od ON od.id = s."orderId" AND od."sellerId" = s."sellerId"
      WHERE s."sellerId" = ${sid}::uuid AND od."paidAt" IS NOT NULL AND od."createdAt" >= ${start} AND od."createdAt" < ${end}
    ),
    ac AS (
      SELECT count(*)::int AS auto_cancelled FROM "Order"
      WHERE "sellerId" = ${sid}::uuid AND "autoCancelledAt" IS NOT NULL AND "createdAt" >= ${start} AND "createdAt" < ${end}
    ),
    outside AS (
      SELECT count(*)::int AS outside_orders, coalesce(sum(o.net), 0) AS outside_net FROM o
      WHERE NOT EXISTS (
        SELECT 1 FROM "BroadcastSession" c
        WHERE c."sellerId" = ${sid}::uuid AND o."createdAt" >= c."startedAt"
          AND o."createdAt" < coalesce(c."endedAt", now()) + ${AFTER_BROADCAST_WINDOW}::interval
      )
    )
    SELECT * FROM nv, rw, sh, ac, outside`;
  return {
    newNet: num(r?.new_net),
    returningNet: num(r?.old_net),
    reward: { earned: num(r?.reward_earn), revoked: num(r?.reward_revoke), used: num(r?.reward_use), expired: num(r?.reward_expire) },
    shipping: { shipped: num(r?.ship_count), avgHours: r?.ship_avg_sec == null ? null : Math.round((r.ship_avg_sec / 3600) * 10) / 10 },
    autoCancelled: num(r?.auto_cancelled),
    outside: { orders: num(r?.outside_orders), net: num(r?.outside_net) },
  };
}

export async function overviewStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  return statsSnapshot(db, async (tx) => {
    const [orders, products, members, broadcasts, current, previous] = await Promise.all([
      orderStatsIn(tx, ctx, range),
      productStatsIn(tx, ctx, range),
      memberStatsIn(tx, ctx, range),
      broadcastStatsIn(tx, ctx, range),
      extras(tx, ctx.sellerId, range.start, range.end),
      extras(tx, ctx.sellerId, range.prev.start, range.prev.end),
    ]);
    // 요약 지표: 매출은 순매출(결제액 − 환불액), 주문은 결제 완료로 남은 주문(취소·환불 제외)
    const kpi = (o: typeof orders.current) => {
      const kept = o.paidOrders - o.refunded;
      return { revenue: o.netRevenue, orders: kept, excluded: o.cancelled + o.refunded, averageOrderValue: kept > 0 ? Math.round(o.netRevenue / kept) : null };
    };
    return {
      range: orders.range,
      summary: {
        current: { ...kpi(orders.current), signups: members.current.signups, buyers: members.current.buyers },
        previous: { ...kpi(orders.previous), signups: members.previous.signups, buyers: members.previous.buyers },
      },
      series: orders.series.map((p) => ({ bucket: p.bucket, revenue: p.netRevenue, orders: p.paidOrders - p.refunded })),
      broadcasts: {
        rows: broadcasts.broadcasts.map((b) => ({ id: b.id, title: b.title, startedAt: b.startedAt, orders: b.orders, net: b.net, hits: b.hits })),
        general: broadcasts.general,
        outside: current.outside,
      },
      products: { top: products.top, total: products.current, unsoldCount: products.unsoldCount },
      members: {
        repeatRate: members.current.repeatRate,
        repeatBuyers: members.current.repeatBuyers,
        buyers: members.current.buyers,
        newNet: current.newNet,
        returningNet: current.returningNet,
      },
      rewards: { ...current.reward, useRate: ratio(current.reward.used, orders.current.netRevenue) },
      operations: {
        shipping: current.shipping,
        autoCancelled: current.autoCancelled,
        autoCancelRate: ratio(current.autoCancelled, orders.current.orders),
        cancelled: orders.current.cancelled,
        refunded: orders.current.refunded,
        refundAmount: orders.current.refundAmount,
      },
      // 데이터가 없는 지표(화면 「준비 중」)
      unavailable: ["visitors", "coupons", "returns", "inquiries", "reviews", "memberGrades", "rewardExpiring", "broadcastViewers"],
    };
  });
}
