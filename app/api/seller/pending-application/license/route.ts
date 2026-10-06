import { NextResponse } from "next/server";
import { readBodyLimited } from "../../../../../lib/server/branding/image";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readCookie, requestMeta } from "../../../../../lib/server/http/route";
import { LICENSE_MAX_BYTES } from "../../../../../lib/server/sellers/businessLicense";
import { PENDING_ACCESS_COOKIE, PENDING_LICENSE_MESSAGES, resolvePendingToken, resubmitLicense } from "../../../../../lib/server/sellers/pendingAccess";

// 보완 요청에 답해 사업자등록증 다시 올리기(AU-005). 본문 = 파일 바이트, 헤더 X-File-Name(URL 인코딩, 선택). JPG·PNG·PDF 10MB 이하.
// 200 { license, supplementClosed } · 401 not_found(쿠키 없음·만료) · 409 not_pending(반려·승인 뒤) · 413 file_too_large · 400 file_type_invalid·file_empty
export const PUT = mutation(async (req: Request) => {
  const ctx = await resolvePendingToken(prisma, readCookie(req, PENDING_ACCESS_COOKIE));
  if (!ctx) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const bytes = await readBodyLimited(req, LICENSE_MAX_BYTES);
  if (!bytes) return NextResponse.json({ error: "file_too_large", message: PENDING_LICENSE_MESSAGES.file_too_large }, { status: 413 });
  let name: string | null = null;
  try {
    name = decodeURIComponent(req.headers.get("x-file-name") ?? "") || null;
  } catch {
    name = null;
  }
  const r = await resubmitLicense(prisma, ctx, bytes, name, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: PENDING_LICENSE_MESSAGES[r.reason] }, { status: r.reason === "not_pending" ? 409 : 400 });
  return NextResponse.json({ license: r.license, supplementClosed: r.supplementClosed });
});
