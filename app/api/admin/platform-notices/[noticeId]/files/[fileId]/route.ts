import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { errorResponse, mutation, noStore, requestMeta, sessionToken } from "../../../../../../../lib/server/http/route";
import { inquiryFileResponse } from "../../../../../../../lib/server/platform-inquiries/files";
import { adminNoticeFile, deleteNoticeFile } from "../../../../../../../lib/server/platform-notices/service";

type Ctx = { params: Promise<{ noticeId: string; fileId: string }> };

// 공지 첨부 받기(마스터 관리자 전 역할). 항상 attachment·nosniff. 없는 파일·지운 공지는 404.
export async function GET(req: Request, { params }: Ctx) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = await params;
    return inquiryFileResponse(await adminNoticeFile(prisma, admin, p.noticeId, p.fileId));
  } catch (e) {
    return errorResponse(e);
  }
}

// 공지 첨부 지우기. 최고관리자·CS. 200 { ok: true } · 404
export const DELETE = mutation(async (req: Request, { params }: Ctx) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.manage");
  const p = await params;
  await deleteNoticeFile(prisma, admin, p.noticeId, p.fileId, requestMeta(req));
  return noStore(NextResponse.json({ ok: true }));
});
