import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { listLivePayoutHistory } from "../../../../../lib/server/rewards/livePayoutAdmin";

// 실제 지급 전환 이력(SA-034). 쿼리 cursor, limit(기본 20, 최대 100). 응답 { history: [{ id, at, enabled, actorName, settled: null | { count, amount }(켠 줄: 일괄 지급한 건수·금액) }], nextCursor }. MEMBER_POINTS 조회.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const p = new URL(req.url).searchParams;
    const r = await listLivePayoutHistory(prisma, ctx, { cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ history: r.history, nextCursor: r.nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
