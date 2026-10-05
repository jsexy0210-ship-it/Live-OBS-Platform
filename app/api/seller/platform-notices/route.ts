import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { listSellerNotices, PLATFORM_NOTICE_MESSAGES } from "../../../../lib/server/platform-notices/service";

// 플랫폼 공지 목록(SA-111). 파트너스 계정 누구나(직원 포함), 구독이 잠기거나 이용 정지 중에도 본다(점검·정책 안내).
// 대상이 파트너스·전체인 게시 공지만. 쿼리: cursor · q(제목·본문 포함, 50자까지) · category(MAINTENANCE|POLICY|FEATURE|GENERAL) · unread=1(안 읽은 것만).
// 응답 { pinned(첫 쪽만), items(20건), nextCursor, unreadCount }. 항목 { id, title, category, isPinned, publishedAt, channels, read }, 목록에는 본문이 없다.
// 형식이 틀린 쿼리는 400(invalid_cursor·invalid_query·invalid_category)과 문구.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    const sp = new URL(req.url).searchParams;
    const r = await listSellerNotices(prisma, ctx, { cursor: sp.get("cursor"), q: sp.get("q"), category: sp.get("category"), unread: sp.get("unread") });
    if (!r.ok) return NextResponse.json({ error: r.reason, message: PLATFORM_NOTICE_MESSAGES[r.reason] }, { status: 400 });
    return NextResponse.json({ pinned: r.pinned, items: r.items, nextCursor: r.nextCursor, unreadCount: r.unreadCount }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
