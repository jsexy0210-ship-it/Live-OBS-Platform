import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listSellerReviews } from "../../../../lib/server/product-reviews/service";

// 리뷰 목록·집계(SA-048). ?status(VISIBLE·PENDING·HELD·HIDDEN)·rating(1~5|low)·waiting=1(답글 대기)·cursor. 조회는 같은 쇼핑몰 파트너스 계정 누구나.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const q = new URL(req.url).searchParams;
    return noStore(NextResponse.json(await listSellerReviews(prisma, ctx, { status: q.get("status"), rating: q.get("rating"), waiting: q.get("waiting"), cursor: q.get("cursor") })));
  } catch (e) {
    return errorResponse(e);
  }
}
