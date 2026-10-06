import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";
import { inquiryFileResponse } from "../../../../../../lib/server/platform-inquiries/files";
import { adminInquiryFile } from "../../../../../../lib/server/platform-inquiries/service";

// 문의 글에 붙은 첨부 파일(마스터 관리자 전 역할). 항상 attachment·nosniff. 붙지 않은 파일·없는 파일은 404.
export async function GET(req: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return inquiryFileResponse(await adminInquiryFile(prisma, admin, (await params).fileId));
  } catch (e) {
    return errorResponse(e);
  }
}
