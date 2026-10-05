import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";
import { sellerInquiryImage } from "../../../../../../lib/server/platform-inquiries/service";
import { reviewImageResponse } from "../../../../../../lib/server/product-reviews/image";

// 문의 사진(자기가 올린 사진, 또는 볼 수 있는 문의에 붙은 사진). 없으면 404.
export async function GET(req: Request, { params }: { params: Promise<{ imageId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return reviewImageResponse(await sellerInquiryImage(prisma, ctx, (await params).imageId), "private");
  } catch (e) {
    return errorResponse(e);
  }
}
