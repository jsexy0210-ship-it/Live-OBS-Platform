import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { broadcastStats } from "../../../../../lib/server/stats/broadcasts";
import { statsResponse } from "../../../../../lib/server/stats/http";

// 방송 통계. SALES_VIEW 권한(대표자·통계 권한 직원), 플랜 기능 OVERLAY.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    return await statsResponse(req, (range) => broadcastStats(prisma, ctx, range));
  } catch (e) {
    return errorResponse(e);
  }
}
