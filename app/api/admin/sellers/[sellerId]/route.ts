import { NextResponse } from "next/server";
import { getAdminSeller } from "../../../../../lib/server/admin/sellers";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 마스터 관리자 파트너스 상세(MA-012): 기본 정보·대표자·구독·최근 30일 주문 요약. 없으면 404. 열람마다 로그 추적 admin.seller.view.
export async function GET(req: Request, { params }: { params: Promise<{ sellerId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const { sellerId } = await params;
    const s = UUID.test(sellerId) ? await getAdminSeller(prisma, admin, sellerId, requestMeta(req)) : null;
    if (!s) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    return noStore(NextResponse.json({ seller: s }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
