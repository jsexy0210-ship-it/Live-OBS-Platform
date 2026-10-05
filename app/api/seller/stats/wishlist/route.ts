import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { statsResponse } from "../../../../../lib/server/stats/http";
import { wishlistStats } from "../../../../../lib/server/stats/wishlist";

// 찜→구매 근사. SALES_VIEW 권한(대표자·통계 권한 직원), 플랜 기능 STORE_OPERATIONS. 쿼리: from·to(KST 날짜, 최대 366일).
// 해제한 찜은 기록이 없어 지금 찜 중인 것만 센 근사치다(approximate: true).
// 응답: { range, approximate, wishes, bought, rate, products[상위 10: productId,name,wishes,bought,rate] }
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return await statsResponse(req, (range) => wishlistStats(prisma, ctx, range));
  } catch (e) {
    return errorResponse(e);
  }
}
