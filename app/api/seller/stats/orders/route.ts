import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { statsResponse } from "../../../../../lib/server/stats/http";
import { orderStats } from "../../../../../lib/server/stats/orders";

// 주문 통계. SALES_VIEW 권한(대표자·통계 권한 직원), 플랜 기능 STORE_OPERATIONS.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return await statsResponse(req, (range) => orderStats(prisma, ctx, range));
  } catch (e) {
    return errorResponse(e);
  }
}
