import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { hourlyStats } from "../../../../../lib/server/stats/hourly";
import { statsResponse } from "../../../../../lib/server/stats/http";

// 시간대별 주문 통계. SALES_VIEW 권한(대표자·통계 권한 직원), 플랜 기능 STORE_OPERATIONS.
// 쿼리: from·to(KST 날짜, 최대 366일). 응답: { range, hours[24: hour, orders, paidOrders, revenue, cancelled, refunded, refundAmount, netRevenue], totalOrders, peakHour }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return await statsResponse(req, (range) => hourlyStats(prisma, ctx, range));
  } catch (e) {
    return errorResponse(e);
  }
}
