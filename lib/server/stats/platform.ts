import { Prisma, type PrismaClient } from "@prisma/client";
import { adminCan } from "../authz/permissions";
import { forbidden } from "../authz/errors";
import type { AdminSessionContext } from "../auth/session";
import { AGG, toPoint, toSummary, type AggRow, type OrderPoint } from "./orders";
import { ratio, type StatsRange } from "./range";
import { bucketOf, bucketSeries, num, statsSnapshot } from "./sql";

// 마스터 관리자 플랫폼 통계(조회 전용, platform.read). 파트너스·구매자 개인정보 없이 숫자만 준다.
// ① 플랫폼 전체 일별 주문·결제: 주문·결제액 기준은 파트너스 주문 통계(orders.ts)와 같다(같은 집계 조각을 쓴다).
//    전기(바로 앞 같은 일수) 합계를 함께 줘 증감을 비교한다.
export async function platformOrderStats(db: PrismaClient, admin: AdminSessionContext, range: StatsRange) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  return statsSnapshot(db, async (tx) => {
    const sum = async (start: Date, end: Date) =>
      toSummary(
        (await tx.$queryRaw<AggRow[]>`SELECT ${AGG} FROM "Order" WHERE "createdAt" >= ${start} AND "createdAt" < ${end}`)[0],
      );
    const [current, previous, series] = await Promise.all([
      sum(range.start, range.end),
      sum(range.prev.start, range.prev.end),
      tx.$queryRaw<(AggRow & { bucket: string })[]>`
        WITH s AS (${bucketSeries(range.unit, range.start, range.end)}),
        o AS (
          SELECT ${bucketOf(range.unit, Prisma.sql`"createdAt"`)} AS b, ${AGG}
          FROM "Order"
          WHERE "createdAt" >= ${range.start} AND "createdAt" < ${range.end}
          GROUP BY 1
        )
        SELECT to_char(s.b, 'YYYY-MM-DD') AS bucket, o.orders, o.paid, o.revenue, o.cancelled, o.refunded, o.refund_amount
        FROM s LEFT JOIN o ON o.b = s.b
        ORDER BY s.b`,
    ]);
    return {
      range: { from: range.from, to: range.to, unit: range.unit, previous: { from: range.prev.from, to: range.prev.to } },
      current,
      previous,
      series: series.map((r): OrderPoint => ({ bucket: r.bucket, ...toPoint(r) })),
    };
  });
}

// ② 월별 구독 매출·수납 결과(마스터 관리자, platform.read). 구독 청구(SubscriptionPayment)의 월(KST) 집계.
// - 청구 시각: 결제된 청구는 결제 시각(paidAt), 실패·진행 중은 청구 생성 시각(createdAt)
// - 매출 = 결제 완료(PAID) 청구 합. 환불 = 환불 완료(REFUNDED) 구독 환불 합(환불 완료 시각 기준 월). 순매출 = 매출 − 환불
// - 수납률 = 결제 완료 건 / (결제 완료 + 실패 건). 진행 중(PENDING)은 분모에서 뺀다
// 조회 기간은 월 단위로 펼친다(unit 쿼리는 무시). 파트너스·카드 정보 없이 숫자만 준다.
type BillingRow = { paid: number; failed: number; pending: number; revenue: bigint };
type RefundRow = { refunds: number; refund_amount: bigint };

const BILLING_AGG = Prisma.sql`
  count(*) FILTER (WHERE status = 'PAID')::int AS paid,
  count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
  count(*) FILTER (WHERE status = 'PENDING')::int AS pending,
  coalesce(sum(amount::bigint) FILTER (WHERE status = 'PAID'), 0) AS revenue`;
const CHARGE_AT = Prisma.sql`coalesce("paidAt", "createdAt")`;

const billingPoint = (b: BillingRow | undefined, r: RefundRow | undefined) => {
  const revenue = num(b?.revenue);
  const refundAmount = num(r?.refund_amount);
  const paid = num(b?.paid);
  const failed = num(b?.failed);
  return {
    paid,
    failed,
    pending: num(b?.pending),
    revenue,
    refunds: num(r?.refunds),
    refundAmount,
    netRevenue: revenue - refundAmount,
    collectionRate: ratio(paid, paid + failed),
  };
};

export async function platformSubscriptionStats(db: PrismaClient, admin: AdminSessionContext, range: StatsRange) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  return statsSnapshot(db, async (tx) => {
    const total = async (start: Date, end: Date) => {
      const [b, r] = await Promise.all([
        tx.$queryRaw<BillingRow[]>`SELECT ${BILLING_AGG} FROM "SubscriptionPayment" WHERE ${CHARGE_AT} >= ${start} AND ${CHARGE_AT} < ${end}`,
        tx.$queryRaw<RefundRow[]>`
          SELECT count(*)::int AS refunds, coalesce(sum(amount::bigint), 0) AS refund_amount FROM "SubscriptionRefund"
          WHERE status = 'REFUNDED' AND "refundedAt" >= ${start} AND "refundedAt" < ${end}`,
      ]);
      return billingPoint(b[0], r[0]);
    };
    const [current, previous, billing, refunds] = await Promise.all([
      total(range.start, range.end),
      total(range.prev.start, range.prev.end),
      tx.$queryRaw<(BillingRow & { bucket: string })[]>`
        WITH s AS (${bucketSeries("month", range.start, range.end)}),
        p AS (
          SELECT ${bucketOf("month", CHARGE_AT)} AS b, ${BILLING_AGG} FROM "SubscriptionPayment"
          WHERE ${CHARGE_AT} >= ${range.start} AND ${CHARGE_AT} < ${range.end} GROUP BY 1
        )
        SELECT to_char(s.b, 'YYYY-MM') AS bucket, p.paid, p.failed, p.pending, p.revenue FROM s LEFT JOIN p ON p.b = s.b ORDER BY s.b`,
      tx.$queryRaw<(RefundRow & { bucket: string })[]>`
        WITH s AS (${bucketSeries("month", range.start, range.end)}),
        f AS (
          SELECT ${bucketOf("month", Prisma.sql`"refundedAt"`)} AS b, count(*)::int AS refunds, coalesce(sum(amount::bigint), 0) AS refund_amount
          FROM "SubscriptionRefund" WHERE status = 'REFUNDED' AND "refundedAt" >= ${range.start} AND "refundedAt" < ${range.end} GROUP BY 1
        )
        SELECT to_char(s.b, 'YYYY-MM') AS bucket, f.refunds, f.refund_amount FROM s LEFT JOIN f ON f.b = s.b ORDER BY s.b`,
    ]);
    const refundOf = new Map(refunds.map((r) => [r.bucket, r]));
    return {
      range: { from: range.from, to: range.to, unit: "month" as const, previous: { from: range.prev.from, to: range.prev.to } },
      current,
      previous,
      series: billing.map((b) => ({ bucket: b.bucket, ...billingPoint(b, refundOf.get(b.bucket)) })),
    };
  });
}

// ③ 신규 파트너스·방송 수 추이(마스터 관리자, platform.read). 숫자만, 개인정보 없음.
// - 가입 신청 = 파트너스 계정 생성(createdAt), 승인 = 승인 시각(approvedAt) 기준. 같은 기간·단위(일·주·월, KST)로 센다
// - 방송 수 = 그 기간에 시작한 방송(startedAt). 방송한 파트너스 = 그 기간에 방송을 시작한 서로 다른 파트너스 수
type GrowthCounts = { signups: number; approved: number; broadcasts: number; broadcasters: number };

const growthPoint = (r: Partial<GrowthCounts> | undefined): GrowthCounts => ({
  signups: num(r?.signups),
  approved: num(r?.approved),
  broadcasts: num(r?.broadcasts),
  broadcasters: num(r?.broadcasters),
});

export async function platformGrowthStats(db: PrismaClient, admin: AdminSessionContext, range: StatsRange) {
  if (!adminCan(admin.admin.role, "platform.read")) throw forbidden();
  return statsSnapshot(db, async (tx) => {
    const total = async (start: Date, end: Date) => {
      const [s, b] = await Promise.all([
        tx.$queryRaw<{ signups: number; approved: number }[]>`
          SELECT count(*) FILTER (WHERE "createdAt" >= ${start} AND "createdAt" < ${end})::int AS signups,
                 count(*) FILTER (WHERE "approvedAt" >= ${start} AND "approvedAt" < ${end})::int AS approved
          FROM "Seller"`,
        tx.$queryRaw<{ broadcasts: number; broadcasters: number }[]>`
          SELECT count(*)::int AS broadcasts, count(DISTINCT "sellerId")::int AS broadcasters
          FROM "BroadcastSession" WHERE "startedAt" >= ${start} AND "startedAt" < ${end}`,
      ]);
      return growthPoint({ ...s[0], ...b[0] });
    };
    const [current, previous, signups, approved, broadcasts] = await Promise.all([
      total(range.start, range.end),
      total(range.prev.start, range.prev.end),
      tx.$queryRaw<{ bucket: string; n: number }[]>`
        WITH s AS (${bucketSeries(range.unit, range.start, range.end)}),
        x AS (SELECT ${bucketOf(range.unit, Prisma.sql`"createdAt"`)} AS b, count(*)::int AS n FROM "Seller"
              WHERE "createdAt" >= ${range.start} AND "createdAt" < ${range.end} GROUP BY 1)
        SELECT to_char(s.b, 'YYYY-MM-DD') AS bucket, x.n FROM s LEFT JOIN x ON x.b = s.b ORDER BY s.b`,
      tx.$queryRaw<{ bucket: string; n: number }[]>`
        WITH s AS (${bucketSeries(range.unit, range.start, range.end)}),
        x AS (SELECT ${bucketOf(range.unit, Prisma.sql`"approvedAt"`)} AS b, count(*)::int AS n FROM "Seller"
              WHERE "approvedAt" >= ${range.start} AND "approvedAt" < ${range.end} GROUP BY 1)
        SELECT to_char(s.b, 'YYYY-MM-DD') AS bucket, x.n FROM s LEFT JOIN x ON x.b = s.b ORDER BY s.b`,
      tx.$queryRaw<{ bucket: string; broadcasts: number; broadcasters: number }[]>`
        WITH s AS (${bucketSeries(range.unit, range.start, range.end)}),
        x AS (SELECT ${bucketOf(range.unit, Prisma.sql`"startedAt"`)} AS b, count(*)::int AS broadcasts, count(DISTINCT "sellerId")::int AS broadcasters
              FROM "BroadcastSession" WHERE "startedAt" >= ${range.start} AND "startedAt" < ${range.end} GROUP BY 1)
        SELECT to_char(s.b, 'YYYY-MM-DD') AS bucket, x.broadcasts, x.broadcasters FROM s LEFT JOIN x ON x.b = s.b ORDER BY s.b`,
    ]);
    return {
      range: { from: range.from, to: range.to, unit: range.unit, previous: { from: range.prev.from, to: range.prev.to } },
      current,
      previous,
      series: signups.map((p, i) => ({ bucket: p.bucket, ...growthPoint({ signups: p.n, approved: approved[i]?.n, ...broadcasts[i] }) })),
    };
  });
}
