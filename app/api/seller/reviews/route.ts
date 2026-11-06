import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listSellerReviews } from "../../../../lib/server/product-reviews/service";

// 리뷰 목록·집계(SA-048). ?status(VISIBLE·PENDING·HELD·HIDDEN)·rating(1~5|low)·waiting=1(답글 대기)·from·to(작성일 기간, KST 날짜 YYYY-MM-DD)·q(검색어 50자까지)·field(product 상품·author 작성자·body 내용, 없으면 셋 모두)·photo=1(사진 리뷰만)·cursor. 응답 matched = 지금 조건에 맞는 전체 개수. 조회는 같은 쇼핑몰 파트너스 계정 누구나.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const q = new URL(req.url).searchParams;
    return noStore(NextResponse.json(await listSellerReviews(prisma, ctx, { status: q.get("status"), rating: q.get("rating"), waiting: q.get("waiting"), cursor: q.get("cursor"), from: q.get("from"), to: q.get("to"), q: q.get("q"), field: q.get("field"), photo: q.get("photo") })));
  } catch (e) {
    return errorResponse(e);
  }
}
