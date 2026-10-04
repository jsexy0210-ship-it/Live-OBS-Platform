import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse } from "../../../../../lib/server/http/route";
import { publicFaqs } from "../../../../../lib/server/shop-notice/service";

// 구매자 쇼핑몰 자주 묻는 질문(SH-030 이용안내 탭). 로그인 없이. ?q=검색어(2자 이상, 문의 작성 전 관련 질문 제안).
// 응답 { faqs: [{ id, category, title, body }](판매자가 정한 순서), categories(쓰인 분류) }. 운영 중이 아닌 쇼핑몰은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const r = await publicFaqs(prisma, (await params).slug, new URL(req.url).searchParams.get("q"));
    if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(r, { headers: { "cache-control": "public, max-age=30" } });
  } catch (e) {
    return errorResponse(e);
  }
}
