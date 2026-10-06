import { NextResponse } from "next/server";
import { listLiveBroadcasts } from "../../../../../lib/server/admin/ops";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 실시간 방송 중 파트너스(MA-041, 조회만, 마스터 관리자 전 역할).
// items.ordersLast60Seconds: 내부 주문 생성(상태 무관), 같은 판매자 [max(at−60초, startedAt), at).
// orderRate: { source, scope: ALL_LIVE_SESSIONS, windowSeconds: 60, from, to: at, total }.
// total은 표시 200건과 별개 모든 LIVE 방송의 중복 없는 내부 주문 수다. 외부 주문·누적 평균은 포함하지 않는다.
// association: SELLER_AND_TIME_WINDOW(방송 ID 직접 연결 아님), externalOrders: NOT_MEASURED(외부 미지원, 0이 아님).
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await listLiveBroadcasts(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
