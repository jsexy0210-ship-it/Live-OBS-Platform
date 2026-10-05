import { buyerScope } from "../../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../../lib/server/db";
import { buyerInquiryImage, imageResponse } from "../../../../../../../lib/server/buyer-inquiries/service";
import { errorResponse } from "../../../../../../../lib/server/http/route";

// 내가 올린 문의 사진(남의 사진·없는 사진은 404)
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; imageId: string }> }) {
  try {
    const { slug, imageId } = await params;
    const b = await buyerScope(req, slug);
    if (!b.scope) return b.res;
    return imageResponse(await buyerInquiryImage(prisma, b.scope, imageId));
  } catch (e) {
    return errorResponse(e);
  }
}
