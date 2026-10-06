import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { readBodyLimited } from "../../../../../../lib/server/branding/image";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { NOTICE_FILE_MAX_BYTES } from "../../../../../../lib/server/platform-notices/files";
import { PLATFORM_NOTICE_MESSAGES, uploadNoticeFile } from "../../../../../../lib/server/platform-notices/service";

// 공지 첨부 올리기(MA-053·054). 최고관리자·CS(공지 작성 권한자). 본문은 파일 바이트 그대로, 파일 이름은 ?name=. .png·.jpg·.pdf, 파일당 5MB(넘으면 끝까지 받지 않고 413), 공지당 5개.
// 201 { file: { id, name, byteSize, url } } · 400 too_many_files · 404(없거나 지운 공지) · 413 file_too_large · 415 unsupported_file(허용 밖 확장자·그림이 아님·PDF가 아님·빈 파일). 공지 version은 올리지 않는다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ noticeId: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.manage");
  const bytes = await readBodyLimited(req, NOTICE_FILE_MAX_BYTES);
  if (!bytes) return noStore(NextResponse.json({ error: "file_too_large", message: "파일은 5MB까지 올릴 수 있습니다" }, { status: 413 }));
  const r = await uploadNoticeFile(prisma, admin, (await params).noticeId, new URL(req.url).searchParams.get("name"), bytes, requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_NOTICE_MESSAGES[r.reason] }, { status: r.reason === "unsupported_file" ? 415 : 400 }));
  return noStore(NextResponse.json({ file: r.file }, { status: 201 }));
});
