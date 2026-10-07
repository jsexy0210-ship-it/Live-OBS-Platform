import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { statsResponse } from "../../../../../lib/server/stats/http";
import { overviewStats } from "../../../../../lib/server/stats/overview";
import { dbNow } from "../../../../../lib/server/billing/subscription";
import { elapsedDayRange, parseStatsRange } from "../../../../../lib/server/stats/range";
import { NextResponse } from "next/server";
import { noStore } from "../../../../../lib/server/http/route";

// 통계 요약(SA-056). SALES_VIEW 권한(대표자·통계 권한 직원), 플랜 기능 STORE_OPERATIONS.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const p = new URL(req.url).searchParams;
    if (p.get("compare") === "elapsed") {
      const range = parseStatsRange({ from: p.get("from"), to: p.get("to"), unit: p.get("unit") });
      const at = await dbNow(prisma);
      const elapsed = range && elapsedDayRange(range, at);
      if (!elapsed) return NextResponse.json({ error: "bad_range" }, { status: 400 });
      return noStore(NextResponse.json({ ...(await overviewStats(prisma, ctx, elapsed)), at }));
    }
    return await statsResponse(req, (range) => overviewStats(prisma, ctx, range));
  } catch (e) {
    return errorResponse(e);
  }
}
