import { NextResponse } from "next/server";
import { prisma } from "../../../../../../../lib/server/db";
import { productReviews } from "../../../../../../../lib/server/product-reviews/service";

// 상품의 공개 리뷰(상품 상세에 끼울 목록, 로그인 없이): { average, total, distribution, reviews, nextCursor }. ?cursor.
// 운영 중이 아니거나 스토어 운영 권한이 없는 쇼핑몰, 없는 상품은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; productId: string }> }) {
  const { slug, productId } = await params;
  const r = await productReviews(prisma, slug, productId, new URL(req.url).searchParams.get("cursor"));
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(r, { headers: { "cache-control": "public, max-age=30" } });
}
