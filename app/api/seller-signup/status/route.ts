import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, readCookie } from "../../../../lib/server/http/route";
import { SELLER_SIGNUP_IDV_COOKIE } from "../../../../lib/server/sellers/signupFlow";
import { signupApplicationStatus } from "../../../../lib/server/sellers/signupAssist";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 파트너스 가입(PF-007-5) 「신청 상태 보기」. GET ?verificationId=. 신청을 마친 이 브라우저(흐름 쿠키, 시작 때 정한 유효 시간 40분)에서만 보인다.
// 응답 { state: APPROVED(승인됨·로그인 가능) | PENDING(확인 중) | SUPPLEMENT(보완 요청) | REJECTED(반려·해지), receivedAt, license: 올린 사업자등록증 요약 | null }.
// 로그인 전이라 사유·보완 내용은 주지 않는다(메일로 안내). 쿠키가 없거나 맞지 않으면 404 not_found.
export async function GET(req: Request) {
  try {
    const id = new URL(req.url).searchParams.get("verificationId") ?? "";
    const r = UUID.test(id) ? await signupApplicationStatus(prisma, id, readCookie(req, SELLER_SIGNUP_IDV_COOKIE)) : null;
    if (!r) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    return noStore(NextResponse.json(r));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
