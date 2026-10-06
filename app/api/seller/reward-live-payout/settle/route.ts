import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { continueSettlement } from "../../../../../lib/server/rewards/settle";

// 켜기 일괄 지급 이어서 처리(SA-034). 본문 없음. 응답 { settlement: { settled, settledAmount, revokedAmount, failed, remaining, skipped: null|"not_live" } }.
// remaining > 0이면 다시 부른다(한 번에 회원 200명까지). 같은 줄을 두 번 지급하지 않는다(여러 번·동시에 불러도 안전). 실제 지급이 꺼져 있으면 skipped: "not_live". MEMBER_POINTS.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  return NextResponse.json({ settlement: await continueSettlement(prisma, ctx, requestMeta(req)) }, { headers: { "cache-control": "no-store" } });
});
