import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";
import { reviewImageResponse } from "../../../../../../lib/server/product-reviews/image";
import { sellerReturnImage } from "../../../../../../lib/server/shop-returns/service";

// 신청에 붙은 사진(같은 쇼핑몰 신청의 사진만, ORDER_SHIPPING). 없으면 404.
export async function GET(req: Request, { params }: { params: Promise<{ imageId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const { imageId } = await params;
    return reviewImageResponse(await sellerReturnImage(prisma, ctx, imageId), "private");
  } catch (e) {
    return errorResponse(e);
  }
}
