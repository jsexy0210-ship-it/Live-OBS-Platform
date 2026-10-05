import { NextResponse } from "next/server";
import { listLivePayoutSellers } from "../../../../../lib/server/admin/ops";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 적립금 실지급 켜진 파트너스(MA-043, 조회만, 마스터 관리자 전 역할).
// { items: [{ sellerId, shopName, slug, status, enabledAt, earnTiming, outstanding: { amount, members } }] }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await listLivePayoutSellers(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
