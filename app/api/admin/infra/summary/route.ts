import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { infraSummary } from "../../../../../lib/server/ops/infraCost";

// 마스터 홈 인프라·비용 요약 카드(최고관리자만). 가볍게 부를 수 있는 한 번의 응답.
// → { checkedAt, servers[{instance,takenAt,diskPct,memoryPct}], cost{month,estimated,accruedWon,projectedWon}, warnings{capacity,limitStopped,expiring30,expiring7,authError,total} }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "infra.manage");
    return noStore(NextResponse.json(await infraSummary(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
