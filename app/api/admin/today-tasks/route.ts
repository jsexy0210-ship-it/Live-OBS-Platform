import { NextResponse } from "next/server";
import { adminTodayTasks } from "../../../../lib/server/admin/todayTasks";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";

// 마스터 관리자 「오늘 처리할 일」(MA-001). 마스터 관리자 전 역할이 본다(조회만).
// → { at, total, items: [{ key: signupPending|paymentFailed|refundRequested|inquiryOpen|pgError|automationFailed|incidentCritical, count, href }] }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await adminTodayTasks(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
