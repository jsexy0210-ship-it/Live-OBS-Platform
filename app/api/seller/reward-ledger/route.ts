import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { listRewardLedger } from "../../../../lib/server/seller-settings/rewardLedger";

// 적립금 지급·회수 원장(SA-032). 쿼리: status(PENDING·SUCCEEDED·FAILED), from·to(생성일 한국 날짜 YYYY-MM-DD, 끝 포함), memberId(회원 한 명의 줄만, UUID), cursor, limit(기본 50, 최대 200). MEMBER_POINTS 권한, 조회만.
// 잠금 중에도 이미 받은 주문의 고객 응대를 위해 볼 수 있다(회원 목록과 같은 기준).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = new URL(req.url).searchParams;
    const r = await listRewardLedger(prisma, ctx, { status: p.get("status"), memberId: p.get("memberId"), cursor: p.get("cursor"), limit: p.get("limit"), from: p.get("from"), to: p.get("to") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ entries: r.entries, nextCursor: r.nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
