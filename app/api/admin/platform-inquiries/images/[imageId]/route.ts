import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";
import { adminInquiryImage } from "../../../../../../lib/server/platform-inquiries/service";
import { reviewImageResponse } from "../../../../../../lib/server/product-reviews/image";

// 문의 글에 붙은 사진(마스터 관리자 전 역할). 붙지 않은 사진·없는 사진은 404.
export async function GET(req: Request, { params }: { params: Promise<{ imageId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return reviewImageResponse(await adminInquiryImage(prisma, admin, (await params).imageId), "private");
  } catch (e) {
    return errorResponse(e);
  }
}
