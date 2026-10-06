import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { listRewardPolicyHistory } from "../../../../../lib/server/rewards/policyAdmin";

// 적립 정책 변경 이력(SA-031). 쿼리 cursor, limit(기본 20, 최대 100). 응답 { history: [{ id, at, actorName, changes: [{kind: rate|earnTiming|revokeMode|rankingBonus, before, after, …}] }], nextCursor }. MEMBER_POINTS 조회.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const p = new URL(req.url).searchParams;
    const r = await listRewardPolicyHistory(prisma, ctx, { cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ history: r.history, nextCursor: r.nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
