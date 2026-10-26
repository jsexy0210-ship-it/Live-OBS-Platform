import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse } from "../../../../../../lib/server/http/route";
import { shopHomeHighlights } from "../../../../../../lib/server/shop/highlights";

// 구매자 쇼핑몰 홈(SH-001)의 「이번 주 인기 카드」 표와 히어로 옆 카드 셋(로그인 없이). 응답:
// { weeklyHits: [{ rank, nickname, cardName, grade|null, createdAt }](최근 7일 HIT 카드 최신순 5장),
//   hero: { benefit: { maxRewardRate(%|null), gradeRefresh: { cadence(MONTHLY|WEEKLY|DAILY), nextRunAt } | null(자동 갱신 꺼짐) }, hit: { weekCount }, notice: { id, title, isPinned, createdAt } | null } }.
// 운영 중이 아닌 쇼핑몰은 404. 30초 캐시.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const r = await shopHomeHighlights(prisma, (await params).slug);
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(r, { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    return errorResponse(e);
  }
}
