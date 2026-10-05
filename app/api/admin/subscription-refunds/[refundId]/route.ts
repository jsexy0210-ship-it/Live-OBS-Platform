import { NextResponse } from "next/server";
import { getSubscriptionRefund } from "../../../../../lib/server/admin/subscriptionRefunds";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 환불 한 건(MA-027). 보기는 마스터 관리자 전 역할. 목록 항목과 같은 모양 { refund }.
export async function GET(req: Request, { params }: { params: Promise<{ refundId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json({ refund: await getSubscriptionRefund(prisma, admin, (await params).refundId) }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
