import { NextResponse } from "next/server";
import { getSellerRewards } from "../../../../../../lib/server/admin/sellerRewards";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 파트너스 상세 「적립금 설정」 탭(MA-012). 마스터 관리자 전 역할 읽기 전용(플랫폼은 설정을 끄거나 바꾸지 않는다, 스위치는 파트너스만).
// → { policy, limits, livePayout, totals, history, anomalies }. 없는 파트너스 404.
export async function GET(req: Request, { params }: { params: Promise<{ sellerId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const { sellerId } = await params;
    const r = UUID.test(sellerId) ? await getSellerRewards(prisma, admin, sellerId) : null;
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return noStore(NextResponse.json(r));
  } catch (e) {
    return errorResponse(e);
  }
}
