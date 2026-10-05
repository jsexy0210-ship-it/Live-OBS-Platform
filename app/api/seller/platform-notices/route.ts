import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";
import { listNotices, PLATFORM_NOTICE_MESSAGES } from "../../../../lib/server/platform-notices/service";

// 플랫폼 공지 목록(SA-111). 파트너스 계정 누구나(직원 포함), 구독이 잠기거나 이용 정지 중에도 본다(점검·정책 안내).
// 대상이 파트너스·전체인 게시 공지만. ?cursor= → { pinned(첫 쪽만), items, nextCursor }. 목록에는 본문이 없다.
export async function GET(req: Request) {
  try {
    await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    const r = await listNotices(prisma, "partners", { cursor: new URL(req.url).searchParams.get("cursor") });
    if (!r.ok) return NextResponse.json({ error: r.reason, message: PLATFORM_NOTICE_MESSAGES[r.reason] }, { status: 400 });
    return NextResponse.json({ pinned: r.pinned, items: r.items, nextCursor: r.nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}
