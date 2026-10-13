import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse } from "../../../../../lib/server/http/route";
import { publicNotices } from "../../../../../lib/server/shop-notice/service";

// 구매자 쇼핑몰 공지 목록(SH-030). 로그인 없이. ?cursor=이전 응답 nextCursor. 응답 { pinned(홈 띠 고정 공지 { id, title, category, createdAt } | null),
// notices: [{ id, title, category, isPinned, createdAt }], nextCursor }. 준비 중·일시 정지에도 열람하고 비활성 쇼핑몰은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const r = await publicNotices(prisma, (await params).slug, new URL(req.url).searchParams.get("cursor"));
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(r, { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    return errorResponse(e);
  }
}
