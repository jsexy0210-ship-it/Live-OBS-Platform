import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { statsResponse } from "../../../../../lib/server/stats/http";
import { platformGrowthStats } from "../../../../../lib/server/stats/platform";

// 신규 파트너스·방송 수 추이(마스터 관리자 전 역할, platform.read, 조회 전용). 쿼리: from·to(KST 날짜, 최대 366일), unit.
// 응답: { range, current, previous(전기), series[] } — signups(가입 신청)·approved(승인)·broadcasts(시작한 방송)·broadcasters(방송한 파트너스).
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return await statsResponse(req, (range) => platformGrowthStats(prisma, admin, range));
  } catch (e) {
    return errorResponse(e);
  }
}
