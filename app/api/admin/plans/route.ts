import { NextResponse } from "next/server";
import { listAdminPlans } from "../../../../lib/server/admin/billing";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";

// 요금제 목록(MA-021·022, 마스터 관리자 전 역할 조회. 바꾸기는 …/plans/{code}/price·trial-limits·mail-quota, 최고관리자만).
// { plans: [{ code, name, listPrice, salePrice, trialDays, trialMessageLimit, trialIdentityLimit, trialStorageMb, mailMonthlyQuota,
//   next: { mailMonthlyQuota, effectiveAt } | null, updatedAt }] }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await listAdminPlans(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
