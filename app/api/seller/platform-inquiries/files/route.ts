import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { readBodyLimited } from "../../../../../lib/server/branding/image";
import { prisma } from "../../../../../lib/server/db";
import { mutation, noStore, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { FILE_MAX_BYTES } from "../../../../../lib/server/platform-inquiries/files";
import { inquiryStatus, PLATFORM_INQUIRY_MESSAGES, uploadInquiryFile } from "../../../../../lib/server/platform-inquiries/service";

// 문의 첨부 파일 올리기(보내기 전, 사진 외 .txt·.log·.zip). 본문은 파일 바이트 그대로, 파일 이름은 ?name=. 5MB를 넘으면 끝까지 받지 않고 413.
// 확장자·내용 검사(실행 형식·그 밖의 확장자·NUL이 든 텍스트·zip 시그니처 아님 → 415 unsupported_file). 사진(.png·.jpg)은 …/images로 올린다.
// 201 { file: { id, name, byteSize, url } } → 보낼 때 fileIds에 넣는다(사진과 합쳐 글당 5개·20MB, 아니면 400 invalid_files).
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
  const bytes = await readBodyLimited(req, FILE_MAX_BYTES);
  if (!bytes) return noStore(NextResponse.json({ error: "file_too_large", message: PLATFORM_INQUIRY_MESSAGES.file_too_large }, { status: 413 }));
  const r = await uploadInquiryFile(prisma, ctx, new URL(req.url).searchParams.get("name"), bytes, requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PLATFORM_INQUIRY_MESSAGES[r.reason] }, { status: inquiryStatus(r.reason) }));
  const { id, name, byteSize } = r.file;
  return noStore(NextResponse.json({ file: { id, name, byteSize, url: `/api/seller/platform-inquiries/files/${id}` } }, { status: 201 }));
});
