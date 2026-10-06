import { NextResponse } from "next/server";
import { getSellerOrders } from "../../../../../../lib/server/admin/sellerOrders";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 파트너스 상세 「주문 현황」 탭(MA-012). 마스터 관리자 전 역할 읽기 전용, 구매자는 방송 닉네임만.
// 쿼리: range(today·7d·1m·3m, 기본 전체), status(all·paid·failed·refund_requested·pending), q(주문 번호 또는 닉네임), page, pageSize(기본 20, 최대 100).
// → { summary, orders, total, page, pageSize, anomalies, monthly }. 없는 파트너스 404, 잘못된 조건 400.
export async function GET(req: Request, { params }: { params: Promise<{ sellerId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const { sellerId } = await params;
    if (!UUID.test(sellerId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const p = new URL(req.url).searchParams;
    const r = await getSellerOrders(prisma, admin, sellerId, { range: p.get("range"), status: p.get("status"), q: p.get("q"), page: p.get("page"), pageSize: p.get("pageSize") });
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    if (!r.ok) return NextResponse.json({ error: "bad_request", message: "조회 조건을 다시 확인해 주십시오" }, { status: 400 });
    const { ok: _ok, ...body } = r;
    return noStore(NextResponse.json(body));
  } catch (e) {
    return errorResponse(e);
  }
}
