import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { statsResponse } from "../../../../../lib/server/stats/http";
import { platformSubscriptionStats } from "../../../../../lib/server/stats/platform";

// 월별 구독 매출·수납 결과(마스터 관리자 전 역할, platform.read, 조회 전용). 쿼리: from·to(KST 날짜, 최대 366일). 항상 월 단위.
// 응답: { range, current, previous(전기), series[] }.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return await statsResponse(req, (range) => platformSubscriptionStats(prisma, admin, range));
  } catch (e) {
    return errorResponse(e);
  }
}
