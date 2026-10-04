import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { getSellerReview } from "../../../../../lib/server/product-reviews/service";

// 리뷰 상세(사진·주문·신고 사유·답글). 다른 쇼핑몰 리뷰는 404.
export async function GET(req: Request, { params }: { params: Promise<{ reviewId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json({ review: await getSellerReview(prisma, ctx, (await params).reviewId) }));
  } catch (e) {
    return errorResponse(e);
  }
}
