import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { couponStats } from "../../../../../lib/server/stats/coupons";
import { statsResponse } from "../../../../../lib/server/stats/http";

// 쿠폰 사용 성과. SALES_VIEW 권한(대표자·통계 권한 직원), 플랜 기능 STORE_OPERATIONS. 쿼리: from·to(KST 날짜, 최대 366일).
// 응답: { range, withCoupon{orders,revenue,averageOrderValue,discount}, withoutCoupon{orders,revenue,averageOrderValue}, useRate, coupons[상위 10: couponId,name,benefit,uses,discount,revenue,averageOrderValue] }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return await statsResponse(req, (range) => couponStats(prisma, ctx, range));
  } catch (e) {
    return errorResponse(e);
  }
}
