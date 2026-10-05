import { NextResponse } from "next/server";
import { listSellerActivity } from "../../../../../lib/server/admin/ops";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 파트너스별 주문·오버레이 접속 현황(MA-042, 조회만, 마스터 관리자 전 역할). 이용 중·정지 파트너스를 가입 최신 순 50곳씩.
// ?cursor= → { at, todayStart, items: [{ sellerId, shopName, slug, status, ordersToday: { created, paid, paidAmount }, live: { startedAt } | null, overlay: { hasUrl, connected, lastSeenAt } }], nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const r = await listSellerActivity(prisma, admin, { cursor: new URL(req.url).searchParams.get("cursor") });
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: "목록을 다시 불러와 주십시오" }, { status: 400 }));
    const { ok: _ok, ...body } = r;
    return noStore(NextResponse.json(body));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
