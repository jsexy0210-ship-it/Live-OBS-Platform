import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listRestockAlerts } from "../../../../lib/server/shop-restock-alerts/service";

// 재입고 알림(SA-017, PRODUCT_MANAGE). 신청이 있는 상품별 수. 응답 { items: [{ productId, name, soldOut, waiting, queued, sent, nextNotifyAt, lastNotifiedAt }] }.
// 재고가 들어오면 waiting → queued(21~08시 KST는 아침 8시로 미룸). 발송 미연결이라 queued를 유지하고 과거 sent는 그대로 읽는다. 신청한 회원은 응답에 넣지 않는다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await listRestockAlerts(prisma, ctx)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
