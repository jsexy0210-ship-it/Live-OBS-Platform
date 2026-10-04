import type { PrismaClient } from "@prisma/client";

// 구매자 본인의 적립금(SH-023 내 적립금, 탈퇴 화면의 「사라지는 적립금」 안내). 대기열 6번.
// balance: 쓸 수 있는 잔액(RewardBalance, SUCCEEDED·실지급 원장만 반영). 없으면 0.
// pendingEarn: 아직 처리되지 않은(PENDING) 실지급 원장 중 들어올 금액의 합. 시험 모드(testMode) 원장은 실제로 지급되지 않아 빼고,
// 회수 같은 음수 원장은 「들어올 금액」이 아니라 넣지 않는다.
export type BuyerRewardBalance = { balance: number; pendingEarn: number };

type Scope = { sellerId: string; buyerMemberId: string };

export async function readBuyerRewardBalance(db: PrismaClient, scope: Scope): Promise<BuyerRewardBalance> {
  const [row, pending] = await Promise.all([
    db.rewardBalance.findUnique({ where: { sellerId_buyerMemberId: scope }, select: { balance: true } }),
    db.rewardLedger.aggregate({
      where: { ...scope, status: "PENDING", testMode: false, amount: { gt: 0 } },
      _sum: { amount: true },
    }),
  ]);
  return { balance: row?.balance ?? 0, pendingEarn: pending._sum.amount ?? 0 };
}
