import { NextResponse } from "next/server";
import { getAdminPayment } from "../../../../../lib/server/admin/billing";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 마스터 관리자 청구 상세(MA-025): 청구·파트너스·구독·결제사 결제 번호·카드 매출전표 주소. 없으면 404.
export async function GET(req: Request, { params }: { params: Promise<{ paymentId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const { paymentId } = await params;
    const payment = UUID.test(paymentId) ? await getAdminPayment(prisma, admin, paymentId) : null;
    if (!payment) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    return noStore(NextResponse.json({ payment }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
