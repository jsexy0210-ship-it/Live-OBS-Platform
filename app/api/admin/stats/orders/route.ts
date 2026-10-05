import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { platformOrderStats } from "../../../../../lib/server/stats/platform";
import { statsResponse } from "../../../../../lib/server/stats/http";

// 플랫폼 전체 일별 주문·결제 통계(마스터 관리자 전 역할, platform.read, 조회 전용). 쿼리: from·to(KST 날짜), unit.
// 응답: { range, current, previous(전기), series[] }. 파트너스 접근은 requireAdmin이 막는다.
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return await statsResponse(req, (range) => platformOrderStats(prisma, admin, range));
  } catch (e) {
    return errorResponse(e);
  }
}
