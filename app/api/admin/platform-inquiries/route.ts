import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listInquiries, PLATFORM_INQUIRY_MESSAGES } from "../../../../lib/server/platform-inquiries/service";

// 파트너스 문의 목록(MA-051). 보기는 마스터 관리자 전 역할. ?status=OPEN|ANSWERED|CLOSED&sellerId=&cursor=&category=&assignee=me|none|관리자 id
// → { items: [{ id, sellerId, shopName, slug, authorName, category, title, status, urgent, assignee({ id, name }|null), createdAt, lastMessageAt, lastAdminMessageAt, closedAt, version }],
//   counts: { OPEN, ANSWERED, CLOSED }, nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const u = new URL(req.url).searchParams;
    const r = await listInquiries(prisma, admin, { status: u.get("status"), sellerId: u.get("sellerId"), cursor: u.get("cursor"), assignee: u.get("assignee"), category: u.get("category") });
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: 400 }));
    return noStore(NextResponse.json({ items: r.items, counts: r.counts, nextCursor: r.nextCursor }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
