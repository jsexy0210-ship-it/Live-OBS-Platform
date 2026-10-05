import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listRestockAlerts } from "../../../../lib/server/shop-restock-alerts/service";

// 재입고 알림(SA-017, PRODUCT_MANAGE). 신청이 있는 상품별 수. 응답 { items: [{ productId, name, soldOut, waiting, queued, sent, nextNotifyAt, lastNotifiedAt }] }.
// 재고가 들어오면 waiting → queued(21~08시 KST는 아침 8시로 미룸) → sent(발송 기록만, 실제 발송은 아직 없음). 신청한 회원은 응답에 넣지 않는다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await listRestockAlerts(prisma, ctx)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
