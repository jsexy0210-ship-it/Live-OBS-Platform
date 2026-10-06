import { Prisma, type PrismaClient } from "@prisma/client";
import { REWARD_EXPIRE_YEARS, REWARD_EXPIRY_NOTICE_DAYS, lastEarnSql } from "../rewards/expire";
import { requireSellerRead, type TenantContext } from "../tenant/context";

// 회원별 적립금 잔액(SA-033, MEMBER_POINTS). 조회만 한다. 항상 ctx.sellerId 범위, 탈퇴 회원은 빠진다(회원 목록과 같은 기준).
// 누적 값은 성공(SUCCEEDED) 원장만 더한다: 적립 = EARN + RANKING_BONUS, 사용 = −USE(취소·환불 반환을 뺀 순사용),
// 회수 = −REVOKE, 소멸 = −EXPIRE, 조정 = ADJUST. 잔액 = 적립 − 사용 − 회수 − 소멸 + 조정.
// 목록 조건(SA-033): q + field(nickname 방송 닉네임·name 이름) · gradeId(지금 등급) · condition(hasBalance 잔액 있음 · expiring 소멸 예정 있음 · pending 지급 대기 있음)
// · sort(recent 최근 변동순(기본) · balance 잔액 많은 순 · expiring 소멸 예정 가까운 순). 쪽은 cursor(이 목록이 준 값 그대로)·limit. 대기만 있고 잔액 행이 없는 회원도 목록에 있다.
// 소멸 예정(expiry): 잔액이 있고 마지막 적립(실지급 PENDING·SUCCEEDED 양수 EARN·보너스·조정)이 있는 회원의 소멸 시각 = 마지막 적립 + 3년(rewards/expire.ts)과 그때 사라질 금액(지금 잔액).
// soon = 30일 안에 소멸(소멸 30일 전 안내와 같은 기준). 「소멸 예정 있음」 조건은 soon인 회원이다. 정렬 expiring은 소멸 시각이 이른 순(소멸 예정이 없는 회원은 뒤).
// summary: 조건에 맞는 전체의 회원 수와 합계 잔액(「N명 · 합계 잔액 X원」). pending: 쇼핑몰 전체 지급 대기 줄 수·지급 예정 금액(빈 상태 「실제 지급을 켜면 대기 중 N건이 반영됩니다」).
export const REWARD_BALANCE_PAGE_DEFAULT = 50;
export const REWARD_BALANCE_PAGE_MAX = 200;

export const REWARD_BALANCE_SORTS = ["recent", "balance", "expiring"] as const;
export const REWARD_BALANCE_CONDITIONS = ["hasBalance", "expiring", "pending"] as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const CURSOR_RE = /^o:(\d{1,7})$/;

export type RewardBalanceQuery = {
  q?: string | null;
  field?: string | null;
  gradeId?: string | null;
  condition?: string | null;
  sort?: string | null;
  cursor?: string | null;
  limit?: string | null;
};

type Row = {
  id: string;
  nickname: string;
  gradeId: string;
  gradeName: string;
  balance: number;
  updatedAt: Date | null;
  expiresAt: Date | null;
  soon: boolean;
};

export async function listRewardBalances(db: PrismaClient, ctx: TenantContext, query: RewardBalanceQuery) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const limit = query.limit == null || query.limit === "" ? REWARD_BALANCE_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, REWARD_BALANCE_PAGE_MAX);
  const cur = query.cursor ? CURSOR_RE.exec(query.cursor) : null;
  if (query.cursor && !cur) return { ok: false as const };
  const offset = cur ? Number(cur[1]) : 0;
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return { ok: false as const };
  const field = query.field || "nickname";
  if (field !== "nickname" && field !== "name") return { ok: false as const };
  if (query.gradeId && !UUID_RE.test(query.gradeId)) return { ok: false as const };
  const sort = query.sort || "recent";
  if (!REWARD_BALANCE_SORTS.includes(sort as (typeof REWARD_BALANCE_SORTS)[number])) return { ok: false as const };
  const condition = query.condition || null;
  if (condition && !REWARD_BALANCE_CONDITIONS.includes(condition as (typeof REWARD_BALANCE_CONDITIONS)[number])) return { ok: false as const };

  const sellerId = ctx.sellerId;
  const now = new Date();
  const soonAt = new Date(now.getTime() + REWARD_EXPIRY_NOTICE_DAYS * 86_400_000);
  const years = Prisma.sql`make_interval(years => ${REWARD_EXPIRE_YEARS}::int)`;
  const filters: Prisma.Sql[] = [];
  if (q) filters.push(Prisma.sql`AND m.${Prisma.raw(field === "name" ? '"name"' : '"broadcastNickname"')} ILIKE ${`%${escapeLike(q)}%`}`);
  if (query.gradeId) filters.push(Prisma.sql`AND m."gradeId" = ${query.gradeId}::uuid`);
  if (condition === "hasBalance") filters.push(Prisma.sql`AND coalesce(b."balance", 0) > 0`);
  if (condition === "expiring") filters.push(Prisma.sql`AND coalesce(b."balance", 0) > 0 AND e."at" IS NOT NULL AND e."at" + ${years} > ${now} AND e."at" + ${years} <= ${soonAt}`);
  if (condition === "pending") filters.push(Prisma.sql`AND EXISTS (SELECT 1 FROM "RewardLedger" p WHERE p."sellerId" = m."sellerId" AND p."buyerMemberId" = m."id" AND p."status" = 'PENDING')`);
  const order =
    sort === "balance"
      ? Prisma.sql`coalesce(b."balance", 0) DESC, b."updatedAt" DESC NULLS LAST, m."id" DESC`
      : sort === "expiring"
        ? Prisma.sql`(CASE WHEN coalesce(b."balance", 0) > 0 AND e."at" IS NOT NULL THEN e."at" + ${years} END) ASC NULLS LAST, m."id" DESC`
        : Prisma.sql`b."updatedAt" DESC NULLS LAST, m."id" DESC`;

  // 대상: 탈퇴하지 않은 회원 중 잔액 행이 있거나 지급 대기 줄이 있는 회원. b = 잔액 행(lastEarnSql이 이 이름을 쓴다), e = 마지막 적립 시각
  const from = Prisma.sql`
    FROM "BuyerMember" m
    LEFT JOIN "RewardBalance" b ON b."sellerId" = m."sellerId" AND b."buyerMemberId" = m."id"
    JOIN "MemberGrade" g ON g."sellerId" = m."sellerId" AND g."id" = m."gradeId"
    LEFT JOIN LATERAL (${lastEarnSql()}) e ON b."buyerMemberId" IS NOT NULL
    WHERE m."sellerId" = ${sellerId}::uuid AND m."deletedAt" IS NULL
      AND (b."buyerMemberId" IS NOT NULL OR EXISTS (SELECT 1 FROM "RewardLedger" p0 WHERE p0."sellerId" = m."sellerId" AND p0."buyerMemberId" = m."id" AND p0."status" = 'PENDING'))
      ${filters.length ? Prisma.join(filters, " ") : Prisma.empty}`;

  const [rows, totals, pending] = await Promise.all([
    db.$queryRaw<Row[]>`
      SELECT m."id", m."broadcastNickname" AS "nickname", g."id" AS "gradeId", g."displayName" AS "gradeName", coalesce(b."balance", 0)::int AS "balance", b."updatedAt",
        CASE WHEN coalesce(b."balance", 0) > 0 AND e."at" IS NOT NULL THEN e."at" + ${years} END AS "expiresAt",
        coalesce(b."balance", 0) > 0 AND e."at" IS NOT NULL AND e."at" + ${years} > ${now} AND e."at" + ${years} <= ${soonAt} AS "soon"
      ${from} ORDER BY ${order} LIMIT ${take + 1} OFFSET ${offset}`,
    db.$queryRaw<{ count: bigint; total: bigint | null }[]>`SELECT count(*)::bigint AS "count", sum(coalesce(b."balance", 0))::bigint AS "total" ${from}`,
    db.rewardLedger.aggregate({ where: { sellerId, status: "PENDING" }, _count: { _all: true }, _sum: { amount: true } }),
  ]);
  const page = rows.slice(0, take);
  const ids = page.map((r) => r.id);
  const [sums, pendingByMember] = ids.length
    ? await Promise.all([
        db.rewardLedger.groupBy({ by: ["buyerMemberId", "type"], where: { sellerId, status: "SUCCEEDED", buyerMemberId: { in: ids } }, _sum: { amount: true } }),
        db.rewardLedger.groupBy({ by: ["buyerMemberId"], where: { sellerId, status: "PENDING", buyerMemberId: { in: ids } }, _count: { _all: true } }),
      ])
    : [[], []];
  const sum = (memberId: string, ...types: string[]) => sums.filter((s) => s.buyerMemberId === memberId && types.includes(s.type)).reduce((a, s) => a + (s._sum.amount ?? 0), 0);
  const pendingOf = new Map(pendingByMember.map((p) => [p.buyerMemberId, p._count._all]));
  return {
    ok: true as const,
    balances: page.map((r) => ({
      member: { id: r.id, broadcastNickname: r.nickname },
      grade: { id: r.gradeId, name: r.gradeName },
      balance: r.balance,
      totalEarned: sum(r.id, "EARN", "RANKING_BONUS"),
      totalUsed: -sum(r.id, "USE"),
      totalRevoked: -sum(r.id, "REVOKE"),
      totalExpired: -sum(r.id, "EXPIRE"),
      totalAdjusted: sum(r.id, "ADJUST"),
      expiry: r.expiresAt ? { amount: r.balance, expiresAt: r.expiresAt, soon: r.soon } : null,
      pendingCount: pendingOf.get(r.id) ?? 0,
      updatedAt: r.updatedAt,
    })),
    summary: { count: Number(totals[0]?.count ?? 0), totalBalance: Number(totals[0]?.total ?? 0) },
    pending: { count: pending._count._all, amount: pending._sum.amount ?? 0 },
    nextCursor: rows.length > take ? `o:${offset + take}` : null,
  };
}
