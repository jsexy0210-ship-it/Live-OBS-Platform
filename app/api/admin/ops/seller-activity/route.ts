import { NextResponse } from "next/server";
import { listSellerActivity } from "../../../../../lib/server/admin/ops";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 파트너스별 주문·오버레이 접속 현황(MA-042, 조회만, 마스터 관리자 전 역할). 이용 중·정지 파트너스를 가입 최신 순 50곳씩.
// ?cursor= → { at, todayStart, items: [{ sellerId, shopName, slug, status, ordersToday: { created, paid, paidAmount }, live: { startedAt } | null, overlay: { hasUrl, connected, lastSeenAt } }], nextCursor }
// ?period=today|7d|30d: KST 오늘 포함 달력일 [period.start, DB at), ordersPeriod·페이지 밖 승인 파트너스 전체 summary.
// 생성 건수는 createdAt, 결제 건수·현재 환불 차감 금액은 paidAt 기준. 기존 ordersToday는 선택 기간과 관계없이 오늘이다.
// 다음 페이지에는 asOf=첫 응답 at를 유지한다. 시간 경계만 고정하고 환불/판매자 상태/연결 정보는 현재 상태다(observedAt).
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const params = new URL(req.url).searchParams;
    const r = await listSellerActivity(prisma, admin, { cursor: params.get("cursor"), period: params.get("period"), asOf: params.get("asOf") });
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: "목록을 다시 불러와 주십시오" }, { status: 400 }));
    const { ok: _ok, ...body } = r;
    return noStore(NextResponse.json(body));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
