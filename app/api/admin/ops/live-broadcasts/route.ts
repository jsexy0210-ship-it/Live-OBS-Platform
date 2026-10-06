import { NextResponse } from "next/server";
import { listLiveBroadcasts } from "../../../../../lib/server/admin/ops";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 실시간 방송 중 파트너스(MA-041, 조회만, 마스터 관리자 전 역할).
// { at, items: [{ sellerId, shopName, slug, sellerStatus, broadcastId, title, startedAt, queue: { waiting, opening, done, cancelled }, orders, overlay: { hasUrl, connected, lastSeenAt }, layoutAspect, paymentError }] }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await listLiveBroadcasts(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
