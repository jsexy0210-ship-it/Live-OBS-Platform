import { NextResponse } from "next/server";
import { publicProductInquiries } from "../../../../../../../lib/server/buyer-inquiries/service";
import { prisma } from "../../../../../../../lib/server/db";

// 상품의 공개 상품 문의 목록(상품 상세 「상품 문의」 칸, 로그인 없이): { total, inquiries, nextCursor }. ?cursor, 최신순 20개.
// 비공개 글은 제목 「비밀글입니다」·내용 없음, 작성자는 첫 글자만, 답변 여부(answered)만 보인다. 문의 사진은 주지 않는다.
// 운영 중이 아니거나 스토어 운영 권한이 없는 쇼핑몰, 보이지 않는 상품은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; productId: string }> }) {
  const { slug, productId } = await params;
  const r = await publicProductInquiries(prisma, slug, productId, new URL(req.url).searchParams.get("cursor"));
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(r, { headers: { "cache-control": "public, max-age=30" } });
}
