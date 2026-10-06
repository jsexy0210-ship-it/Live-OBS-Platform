import { requireSeller } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../../lib/server/http/route";
import { inquiryFileResponse } from "../../../../../../../lib/server/platform-inquiries/files";
import { sellerNoticeFile } from "../../../../../../../lib/server/platform-notices/service";

// 공지 첨부 받기(파트너스, 받기만). 파트너스에게 게시된 공지의 파일만(임시 저장·지운 공지·공개 전용 공지는 404). 잠김·정지 중에도 받는다. 항상 attachment·nosniff.
export async function GET(req: Request, { params }: { params: Promise<{ noticeId: string; fileId: string }> }) {
  try {
    await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    const p = await params;
    return inquiryFileResponse(await sellerNoticeFile(prisma, p.noticeId, p.fileId));
  } catch (e) {
    return errorResponse(e);
  }
}
