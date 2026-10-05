import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listSellerNotifications } from "../../../../lib/server/notifications/service";

// 파트너스 알림 센터(SA-130). 계정 누구나(직원 포함), 구독이 잠기거나 이용 정지 중에도 본다(공지·문의 답변 확인).
// → { items: [{ id, kind: NOTICE|INQUIRY_REPLY|DEPOSIT_PENDING|ORDER_PAID|OUT_OF_STOCK|RETURN_REQUESTED, title, href, createdAt, unread }], unreadCount }(최신순 30건, 종류별 최대 10건)
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return noStore(NextResponse.json(await listSellerNotifications(prisma, ctx)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
