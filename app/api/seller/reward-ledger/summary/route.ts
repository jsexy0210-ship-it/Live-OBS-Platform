import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { rewardLedgerSummary } from "../../../../../lib/server/seller-settings/rewardLedger";

// 원장 요약 카드(SA-032): { pending:{count,amount}, todaySucceeded:{count,amount}, failed:{count,amount}, todayRevoked:{count,amount}, issuedBalance }. MEMBER_POINTS 조회만.
// 잠금 중에도 이미 받은 주문의 고객 응대를 위해 볼 수 있다(원장 목록과 같은 기준).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    return NextResponse.json({ summary: await rewardLedgerSummary(prisma, ctx) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
