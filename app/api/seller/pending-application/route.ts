import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, readCookie } from "../../../../lib/server/http/route";
import { PENDING_ACCESS_COOKIE, pendingApplicationView, resolvePendingToken } from "../../../../lib/server/sellers/pendingAccess";

// 승인 대기·반려 신청 안내(AU-005 후속). 로그인 시도에서 받은 「신청 확인」 쿠키(15분, sellers/pendingAccess.ts)로만 본다.
// 응답 { state: PENDING | SUPPLEMENT(보완 요청) | REJECTED, delayed(목표 시간 넘김), receivedAt, supplement: { reason, dueAt, daysLeft } | null, rejectedReason, license }.
// 쿠키가 없거나 만료·맞지 않으면 404 not_found(화면은 기본 안내만 보인다).
export async function GET(req: Request) {
  try {
    const ctx = await resolvePendingToken(prisma, readCookie(req, PENDING_ACCESS_COOKIE));
    if (!ctx) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    return noStore(NextResponse.json(await pendingApplicationView(prisma, ctx)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
