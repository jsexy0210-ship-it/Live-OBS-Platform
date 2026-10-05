import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { sellerTodayTasks } from "../../../../lib/server/stats/sellerTodayTasks";

// 파트너스 홈 「오늘 처리할 일」(SA-002). 조회만. 잠금 중에도 이미 받은 주문 처리 항목은 본다(allowUnpaid·ORDER_FOLLOWUP).
// → { total, items: [{ key: depositPending|shipPending|returnRequested|inquiryWaiting|stockOut|stockLow, count, href }] } 조회 권한이 없는 항목은 빠진다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    return noStore(NextResponse.json(await sellerTodayTasks(prisma, ctx)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
