import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { statsResponse } from "../../../../../lib/server/stats/http";
import { platformTopSellers } from "../../../../../lib/server/stats/platform";

// 상위 5 파트너스(순매출 순, 마스터 관리자 전 역할, platform.read, 조회 전용). 쿼리: from·to(KST 날짜, 최대 366일).
// 응답: { range, platformNetRevenue, rows[{ rank, sellerId, shopName, slug, orders, paidOrders, revenue, refundAmount, netRevenue, share }] }.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return await statsResponse(req, (range) => platformTopSellers(prisma, admin, range));
  } catch (e) {
    return errorResponse(e);
  }
}
