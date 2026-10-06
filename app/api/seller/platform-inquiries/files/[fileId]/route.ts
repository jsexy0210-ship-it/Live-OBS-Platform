import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";
import { inquiryFileResponse } from "../../../../../../lib/server/platform-inquiries/files";
import { sellerInquiryFile } from "../../../../../../lib/server/platform-inquiries/service";

// 문의 첨부 파일 받기(자기가 올린 파일, 또는 볼 수 있는 문의에 붙은 파일). 항상 attachment·nosniff. 없으면 404.
export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    return inquiryFileResponse(await sellerInquiryFile(prisma, ctx, (await params).fileId));
  } catch (e) {
    return errorResponse(e);
  }
}
