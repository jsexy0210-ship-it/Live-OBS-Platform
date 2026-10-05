import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listAdminNotifications } from "../../../../lib/server/notifications/service";

// 마스터 관리자 알림 센터(MA-002). 보기는 전 역할. 답변을 기다리는 문의(OPEN) 최근 30건과 전체 건수.
// → { items: [{ id, kind: INQUIRY_WAITING, title, href, createdAt, unread }], unreadCount }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return noStore(NextResponse.json(await listAdminNotifications(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
