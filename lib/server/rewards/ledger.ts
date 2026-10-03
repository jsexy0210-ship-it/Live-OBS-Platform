import type { Prisma } from "@prisma/client";

// 처리 대기(PENDING) 적립 원장을 만드는 모든 경로는 이 함수를 쓴다(지급·회수·랭킹 보너스·조정).
// 회원 행을 FOR SHARE로 잠가 탈퇴(회원 행 FOR NO KEY UPDATE)와 순서를 맞춘다:
// - 원장이 먼저면 탈퇴가 기다렸다가 이 PENDING을 FAILED(member_withdrawn)로 닫는다(buyers/withdraw.ts).
// - 탈퇴가 먼저면 여기서 WITHDRAWN을 보고 처음부터 FAILED(member_withdrawn)로 남긴다. 탈퇴 회원 잔액에 다시 들어가지 않는다.
export async function createPendingRewardLedger(tx: Prisma.TransactionClient, data: Omit<Prisma.RewardLedgerUncheckedCreateInput, "status" | "failureReason" | "processedAt">) {
  const [m] = await tx.$queryRaw<{ status: string }[]>`
    SELECT "status"::text AS "status" FROM "BuyerMember" WHERE "id" = ${data.buyerMemberId}::uuid AND "sellerId" = ${data.sellerId}::uuid FOR SHARE`;
  const withdrawn = m?.status === "WITHDRAWN";
  return tx.rewardLedger.create({
    data: {
      ...data,
      status: withdrawn ? "FAILED" : "PENDING",
      ...(withdrawn ? { failureReason: "member_withdrawn", processedAt: data.createdAt ?? new Date() } : {}),
    },
  });
}
