import { NextResponse } from "next/server";
import { readBodyLimited } from "../../../../lib/server/branding/image";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readCookie } from "../../../../lib/server/http/route";
import { LICENSE_MAX_BYTES, LICENSE_MESSAGES, deleteDraftLicense, putDraftLicense, readDraftLicense } from "../../../../lib/server/sellers/businessLicense";
import { SELLER_SIGNUP_IDV_COOKIE } from "../../../../lib/server/sellers/signupFlow";
import { ownedVerification } from "../../../../lib/server/sellers/signupAssist";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 파트너스 가입(PF-007-4) 사업자등록증 올리기. ?verificationId=(본인확인 기록)로 이 브라우저의 본인확인(완료·30분 안·아직 안 쓴 것)만 쓴다.
// PUT: 본문 = 파일 바이트, 헤더 X-File-Name(URL 인코딩된 이름, 선택). JPG·PNG·PDF 10MB 이하를 앞부분 바이트로 확인한다(이름·Content-Type은 믿지 않음).
//   넘는 크기는 끝까지 받지 않고 413 file_too_large, 형식이 틀리면 400 file_type_invalid, 빈 파일 400 file_empty, 본인확인 문제 409 verification_invalid.
//   다시 올리면 바뀐다. 응답 { license: { fileName, mimeType, byteSize, uploadedAt } }.
// GET: 올린 파일 요약 { license | null }. DELETE: 올린 파일 지우기. 신청을 만들면 파일이 쇼핑몰로 옮겨진다(apply 응답 license).
async function owned(req: Request) {
  const id = new URL(req.url).searchParams.get("verificationId") ?? "";
  if (!UUID.test(id)) return null;
  return ownedVerification(prisma, id, readCookie(req, SELLER_SIGNUP_IDV_COOKIE));
}
const invalid = () => NextResponse.json({ error: "verification_invalid" }, { status: 409 });

export async function GET(req: Request) {
  try {
    const v = await owned(req);
    if (!v) return noStore(invalid());
    return noStore(NextResponse.json({ license: await readDraftLicense(prisma, v.id) }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

export const PUT = mutation(async (req: Request) => {
  const v = await owned(req);
  if (!v) return invalid();
  const bytes = await readBodyLimited(req, LICENSE_MAX_BYTES);
  if (!bytes) return NextResponse.json({ error: "file_too_large", message: LICENSE_MESSAGES.file_too_large }, { status: 413 });
  let name: string | null = null;
  try {
    name = decodeURIComponent(req.headers.get("x-file-name") ?? "") || null;
  } catch {
    name = null;
  }
  const r = await putDraftLicense(prisma, v.id, bytes, name);
  if (!r.ok) return NextResponse.json({ error: r.reason, message: LICENSE_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ license: r.license });
});

export const DELETE = mutation(async (req: Request) => {
  const v = await owned(req);
  if (!v) return invalid();
  await deleteDraftLicense(prisma, v.id);
  return NextResponse.json({ license: null });
});
