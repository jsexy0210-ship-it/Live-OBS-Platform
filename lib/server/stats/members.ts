import { Prisma, type PrismaClient } from "@prisma/client";
import { requireSellerRead, type TenantContext } from "../tenant/context";
import { ratio, type StatsRange } from "./range";
import { bucketOf, bucketSeries, num, statsSnapshot, type StatsDb } from "./sql";

// 회원 통계(SALES_VIEW). 날짜는 KST.
// - 신규 가입: 그 기간에 가입(createdAt)한 회원(지금 탈퇴했어도 센다)
// - 탈퇴: 그 기간에 탈퇴(deletedAt)한 회원
// - 구매 회원: 그 기간에 들어온 결제 주문(paidAt 있음, 환불 포함)이 있는 회원
// - 재구매 회원: 구매 회원 중 기간 끝까지 누적 결제 주문이 2건 이상인 회원. 재구매율 = 재구매 회원 / 구매 회원
// 개인정보(이름·연락처)는 응답에 넣지 않는다.

type Summary = { signups: number; withdrawals: number; buyers: number; repeatBuyers: number; repeatRate: number | null };

async function summary(db: StatsDb, sid: string, start: Date, end: Date): Promise<Summary> {
  const [m, b] = await Promise.all([
    db.$queryRaw<{ signups: number; withdrawals: number }[]>`
      SELECT
        count(*) FILTER (WHERE "createdAt" >= ${start} AND "createdAt" < ${end})::int AS signups,
        count(*) FILTER (WHERE "deletedAt" >= ${start} AND "deletedAt" < ${end})::int AS withdrawals
      FROM "BuyerMember"
      WHERE "sellerId" = ${sid}::uuid
        AND (("createdAt" >= ${start} AND "createdAt" < ${end}) OR ("deletedAt" >= ${start} AND "deletedAt" < ${end}))`,
    db.$queryRaw<{ buyers: number; repeat: number }[]>`
      WITH buyers AS (
        SELECT DISTINCT "buyerMemberId" AS id FROM "Order"
        WHERE "sellerId" = ${sid}::uuid AND "paidAt" IS NOT NULL AND "createdAt" >= ${start} AND "createdAt" < ${end}
      )
      SELECT count(*)::int AS buyers,
        count(*) FILTER (WHERE (
          SELECT count(*) FROM "Order" o
          WHERE o."sellerId" = ${sid}::uuid AND o."buyerMemberId" = buyers.id AND o."paidAt" IS NOT NULL AND o."createdAt" < ${end}
        ) >= 2)::int AS repeat
      FROM buyers`,
  ]);
  const buyers = num(b[0]?.buyers);
  const repeatBuyers = num(b[0]?.repeat);
  return { signups: num(m[0]?.signups), withdrawals: num(m[0]?.withdrawals), buyers, repeatBuyers, repeatRate: ratio(repeatBuyers, buyers) };
}

export async function memberStats(db: PrismaClient, ctx: TenantContext, range: StatsRange) {
  requireSellerRead(ctx, "SALES_VIEW");
  return statsSnapshot(db, (tx) => memberStatsIn(tx, ctx, range));
}

// 같은 스냅숏 안에서 다른 집계와 함께 부를 때(통계 요약). 권한 검사는 부르는 쪽이 한다.
export async function memberStatsIn(tx: StatsDb, ctx: TenantContext, range: StatsRange) {
  const sid = ctx.sellerId;
  const [current, previous, series] = await Promise.all([
    summary(tx, sid, range.start, range.end),
    summary(tx, sid, range.prev.start, range.prev.end),
    tx.$queryRaw<{ bucket: string; signups: number | null; withdrawals: number | null; buyers: number | null }[]>`
      WITH s AS (${bucketSeries(range.unit, range.start, range.end)}),
      su AS (
        SELECT ${bucketOf(range.unit, Prisma.sql`"createdAt"`)} AS b, count(*)::int AS n FROM "BuyerMember"
        WHERE "sellerId" = ${sid}::uuid AND "createdAt" >= ${range.start} AND "createdAt" < ${range.end} GROUP BY 1
      ),
      wd AS (
        SELECT ${bucketOf(range.unit, Prisma.sql`"deletedAt"`)} AS b, count(*)::int AS n FROM "BuyerMember"
        WHERE "sellerId" = ${sid}::uuid AND "deletedAt" >= ${range.start} AND "deletedAt" < ${range.end} GROUP BY 1
      ),
      bu AS (
        SELECT ${bucketOf(range.unit, Prisma.sql`"createdAt"`)} AS b, count(DISTINCT "buyerMemberId")::int AS n FROM "Order"
        WHERE "sellerId" = ${sid}::uuid AND "paidAt" IS NOT NULL AND "createdAt" >= ${range.start} AND "createdAt" < ${range.end} GROUP BY 1
      )
      SELECT to_char(s.b, 'YYYY-MM-DD') AS bucket, su.n AS signups, wd.n AS withdrawals, bu.n AS buyers
      FROM s LEFT JOIN su ON su.b = s.b LEFT JOIN wd ON wd.b = s.b LEFT JOIN bu ON bu.b = s.b
      ORDER BY s.b`,
  ]);
  return {
    range: { from: range.from, to: range.to, unit: range.unit, previous: { from: range.prev.from, to: range.prev.to } },
    current,
    previous,
    series: series.map((r) => ({ bucket: r.bucket, signups: num(r.signups), withdrawals: num(r.withdrawals), buyers: num(r.buyers) })),
  };
}
