import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { listRewardBalances } from "../../../../lib/server/seller-settings/rewardBalances";

// 회원별 적립금 잔액(SA-033). 쿼리: q(방송 닉네임), cursor, limit(기본 50, 최대 200). MEMBER_POINTS 권한, 조회만.
// 잠금 중에도 이미 받은 주문의 고객 응대를 위해 볼 수 있다(회원 목록과 같은 기준).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = new URL(req.url).searchParams;
    const r = await listRewardBalances(prisma, ctx, { q: p.get("q"), cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ balances: r.balances, nextCursor: r.nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
