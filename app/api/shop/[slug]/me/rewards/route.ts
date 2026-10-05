import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../../../lib/server/http/route";
import { readBuyerRewardBalance } from "../../../../../../lib/server/rewards/balance";

// 구매자 본인의 적립금 잔액(로그인한 쇼핑몰 회원만, 잠긴 쇼핑몰이어도 연다: 탈퇴 전 확인용).
// GET → { balance, pendingEarn }(원), useEnabled(주문서에서 적립금을 쓸 수 있는지 = 판매자 적립금 실지급 켜짐, payments/rewardUse.ts와 같은 기준).
// 다른 회원·다른 쇼핑몰 값은 세션으로만 정해서 섞이지 않는다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const b = await buyerScope(req, (await params).slug);
    if (!b.scope) return noStore(b.res);
    const [balance, policy] = await Promise.all([
      readBuyerRewardBalance(prisma, b.scope),
      prisma.rewardPolicy.findUnique({ where: { sellerId: b.scope.sellerId }, select: { livePayoutEnabled: true } }),
    ]);
    return noStore(NextResponse.json({ ...balance, useEnabled: policy?.livePayoutEnabled === true }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
