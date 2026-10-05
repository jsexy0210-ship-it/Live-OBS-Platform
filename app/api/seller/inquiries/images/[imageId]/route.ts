import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { imageResponse, sellerInquiryImage } from "../../../../../../lib/server/buyer-inquiries/service";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";

// 문의에 붙은 사진(같은 쇼핑몰 파트너스 계정만, 다른 쇼핑몰 사진은 404)
export async function GET(req: Request, { params }: { params: Promise<{ imageId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return imageResponse(await sellerInquiryImage(prisma, ctx, (await params).imageId));
  } catch (e) {
    return errorResponse(e);
  }
}
