import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";
import { reviewImageResponse } from "../../../../../../lib/server/product-reviews/image";
import { sellerReviewImage } from "../../../../../../lib/server/product-reviews/service";

// 리뷰 사진(파트너스 관리자, 숨긴·보류 리뷰 포함). 리뷰에 붙지 않은 사진·다른 쇼핑몰 사진은 404.
export async function GET(req: Request, { params }: { params: Promise<{ imageId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return reviewImageResponse(await sellerReviewImage(prisma, ctx, (await params).imageId), "private");
  } catch (e) {
    return errorResponse(e);
  }
}
