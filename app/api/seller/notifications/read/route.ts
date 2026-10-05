import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { markSellerNotificationsSeen } from "../../../../../lib/server/notifications/service";

// 알림 센터를 연 것으로 남긴다(공지 알림 읽음). 문의 답변은 문의를 열어야 읽음이다. 마스터 대리 조회는 403.
export async function POST(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    await markSellerNotificationsSeen(prisma, ctx);
    return noStore(NextResponse.json({ ok: true }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
