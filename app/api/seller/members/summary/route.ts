import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { sellerMemberSummary } from "../../../../../lib/server/buyers/sellerMembers";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";

// 회원 목록 위 요약 6칸(전체·이번 달 신규·이번 달 결제 회원·골드/VIP·구매 제한·혜택·소식 동의). 목록과 같은 권한·잠금 기준.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    return NextResponse.json({ summary: await sellerMemberSummary(prisma, ctx) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
