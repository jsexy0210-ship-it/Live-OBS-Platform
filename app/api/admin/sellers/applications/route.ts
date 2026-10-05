import { NextResponse } from "next/server";
import { listApplications } from "../../../../../lib/server/admin/signupApplications";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";

export const dynamic = "force-dynamic";

// 마스터 가입 신청 목록(MA-013). ?tab=review|supplement|history&sort=old|new&q=&result=auto|approved|rejected(이력만)&cursor=&limit=
// → { now, tab, kpi, counts, items[], total, nextCursor }. 조회는 모든 마스터 역할.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const r = await listApplications(prisma, admin, { tab: p.get("tab"), sort: p.get("sort"), q: p.get("q"), result: p.get("result"), cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return NextResponse.json({ error: "invalid_query" }, { status: 400 });
    return NextResponse.json(r, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
