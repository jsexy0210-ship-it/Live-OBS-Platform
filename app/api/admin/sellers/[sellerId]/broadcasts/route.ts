import { NextResponse } from "next/server";
import { adminSellerBroadcastHistory } from "../../../../../../lib/server/broadcast/history";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";

// 파트너스별 방송 이력(MA-012 탭). 마스터 관리자 전 역할(조회 전용 포함). 파트너스 방송 이력(SA-054)과 같은 모양:
// ?from=YYYY-MM-DD&to=YYYY-MM-DD(KST, 끝 포함, 방송 시작일 기준)&cursor= → { items: [{ id, title, status(live·ended), startedAt, endedAt, summary }], nextCursor }(최신순 50개).
// 잘못된 기간은 400 invalid_range, 없는 파트너스는 404.
export async function GET(req: Request, { params }: { params: Promise<{ sellerId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const q = new URL(req.url).searchParams;
    const r = await adminSellerBroadcastHistory(prisma, admin, (await params).sellerId, { from: q.get("from"), to: q.get("to"), cursor: q.get("cursor") });
    if (!r.ok) return r.reason === "not_found" ? NextResponse.json({ error: "not_found" }, { status: 404 }) : NextResponse.json({ error: r.reason, message: "조회 기간을 다시 확인해 주십시오" }, { status: 400 });
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return errorResponse(e);
  }
}
