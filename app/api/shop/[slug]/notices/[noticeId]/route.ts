import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse } from "../../../../../../lib/server/http/route";
import { publicNotice } from "../../../../../../lib/server/shop-notice/service";

// 구매자 쇼핑몰 공지 상세. 응답 { notice: { id, title, body, isPinned, createdAt, updatedAt } }. 비공개·없는 공지는 404.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; noticeId: string }> }) {
  try {
    const { slug, noticeId } = await params;
    const notice = await publicNotice(prisma, slug, noticeId);
    if (!notice) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ notice }, { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    return errorResponse(e);
  }
}
