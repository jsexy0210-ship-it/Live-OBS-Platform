import type { Prisma, PrismaClient } from "@prisma/client";
import { decodeCursor, encodeCursor } from "../orders/read";
import { requireSellerRead, type TenantContext } from "../tenant/context";

// 회원별 적립금 잔액(SA-033, MEMBER_POINTS). 조회만 한다. 항상 ctx.sellerId 범위, 탈퇴 회원은 빠진다(회원 목록과 같은 기준).
// 누적 값은 성공(SUCCEEDED) 원장만 더한다: 적립 = EARN + RANKING_BONUS, 사용 = −USE(취소·환불 반환을 뺀 순사용),
// 회수 = −REVOKE, 소멸 = −EXPIRE, 조정 = ADJUST. 잔액 = 적립 − 사용 − 회수 − 소멸 + 조정.
export const REWARD_BALANCE_PAGE_DEFAULT = 50;
export const REWARD_BALANCE_PAGE_MAX = 200;

export type RewardBalanceQuery = { q?: string | null; cursor?: string | null; limit?: string | null };

// 잔액이 마지막으로 바뀐 시각 내림차순, (updatedAt, buyerMemberId) 커서 페이지. q는 방송 닉네임 부분 일치. 잘못된 값이면 { ok: false }.
export async function listRewardBalances(db: PrismaClient, ctx: TenantContext, query: RewardBalanceQuery) {
  requireSellerRead(ctx, "MEMBER_POINTS");
  const limit = query.limit == null || query.limit === "" ? REWARD_BALANCE_PAGE_DEFAULT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) return { ok: false as const };
  const take = Math.min(limit, REWARD_BALANCE_PAGE_MAX);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;
  if (query.cursor && !cursor) return { ok: false as const };
  const q = query.q?.trim() ?? "";
  if (q.length > 50) return { ok: false as const };

  const and: Prisma.RewardBalanceWhereInput[] = [{ sellerId: ctx.sellerId, buyerMember: { deletedAt: null } }];
  if (q) and.push({ buyerMember: { broadcastNickname: { contains: q, mode: "insensitive" } } });
  if (cursor) and.push({ OR: [{ updatedAt: { lt: cursor.createdAt } }, { updatedAt: cursor.createdAt, buyerMemberId: { lt: cursor.id } }] });

  const rows = await db.rewardBalance.findMany({
    where: { AND: and },
    orderBy: [{ updatedAt: "desc" }, { buyerMemberId: "desc" }],
    take: take + 1,
    select: { balance: true, updatedAt: true, buyerMember: { select: { id: true, broadcastNickname: true } } },
  });
  const page = rows.slice(0, take);
  const last = page[page.length - 1];
  const sums = page.length
    ? await db.rewardLedger.groupBy({
        by: ["buyerMemberId", "type"],
        where: { sellerId: ctx.sellerId, status: "SUCCEEDED", buyerMemberId: { in: page.map((r) => r.buyerMember.id) } },
        _sum: { amount: true },
      })
    : [];
  const sum = (memberId: string, ...types: string[]) =>
    sums.filter((s) => s.buyerMemberId === memberId && types.includes(s.type)).reduce((a, s) => a + (s._sum.amount ?? 0), 0);
  return {
    ok: true as const,
    balances: page.map((r) => {
      const id = r.buyerMember.id;
      return {
        member: { id, broadcastNickname: r.buyerMember.broadcastNickname },
        balance: r.balance,
        totalEarned: sum(id, "EARN", "RANKING_BONUS"),
        totalUsed: -sum(id, "USE"),
        totalRevoked: -sum(id, "REVOKE"),
        totalExpired: -sum(id, "EXPIRE"),
        totalAdjusted: sum(id, "ADJUST"),
        updatedAt: r.updatedAt,
      };
    }),
    nextCursor: rows.length > take && last ? encodeCursor(last.updatedAt, last.buyerMember.id) : null,
  };
}
