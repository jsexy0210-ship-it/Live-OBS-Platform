import { NextResponse } from "next/server";
import { prisma } from "../../../../../../../lib/server/db";
import { productReviews } from "../../../../../../../lib/server/product-reviews/service";

// 상품의 공개 리뷰(상품 상세에 끼울 목록, 로그인 없이): { average, total, photoCount(사진 리뷰 수), distribution, reviews, nextCursor }. ?cursor, ?photoOnly=true(reviews 목록만 사진 리뷰로 거름, 요약 숫자는 전체 그대로).
// 운영 중이 아니거나 스토어 운영 권한이 없는 쇼핑몰, 없는 상품은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; productId: string }> }) {
  const { slug, productId } = await params;
  const sp = new URL(req.url).searchParams;
  const photoOnly = ["true", "1"].includes((sp.get("photoOnly") ?? "").toLowerCase());
  const r = await productReviews(prisma, slug, productId, sp.get("cursor"), photoOnly);
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(r, { headers: { "cache-control": "public, max-age=30" } });
}
