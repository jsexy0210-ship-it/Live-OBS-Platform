import { NextResponse } from "next/server";
import { adminDashboard } from "../../../../lib/server/admin/dashboard";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";

// 마스터 관리자 통합 대시보드 요약(MA-001). 마스터 관리자 전 역할이 본다.
// { at, todayStart, sellers: { total, PENDING, ACTIVE, SUSPENDED, REJECTED, CLOSED }, liveBroadcasts,
//   ordersToday: { created, paid, paidAmount }, subscriptions: { trial, paid, charging, grace, expired }, pastDue }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await adminDashboard(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
