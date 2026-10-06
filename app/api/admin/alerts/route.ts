import { NextResponse } from "next/server";
import { ADMIN_ALERT_MESSAGES, listAdminAlerts } from "../../../../lib/server/admin-alerts/service";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";

// 알림 센터 저장형 알림 목록(MA-002). 보기는 마스터 관리자 전 역할(알림마다 보는 역할이 따로 있음). ?status=OPEN|IN_PROGRESS|RESOLVED&severity=URGENT|WARNING|INFO&kind=&assignee=me|none|관리자 id&cursor=
// → { items: [{ id, kind, severity, title, body, linkPath, sellerId, shopName, status, assignee({id,name}|null), occurredAt, resolvedAt, unread }],
//     counts: { OPEN, IN_PROGRESS, RESOLVED }, unreadCount, nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const u = new URL(req.url).searchParams;
    const r = await listAdminAlerts(prisma, admin, { status: u.get("status"), severity: u.get("severity"), kind: u.get("kind"), assignee: u.get("assignee"), cursor: u.get("cursor") });
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: ADMIN_ALERT_MESSAGES[r.reason] }, { status: 400 }));
    return noStore(NextResponse.json({ items: r.items, counts: r.counts, unreadCount: r.unreadCount, nextCursor: r.nextCursor }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
