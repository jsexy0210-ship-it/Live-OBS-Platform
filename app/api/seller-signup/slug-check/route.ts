import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { clientIp, errorResponse, noStore } from "../../../../lib/server/http/route";
import { checkSlug, slugCheckAllowed } from "../../../../lib/server/sellers/signupAssist";

// 파트너스 가입(PF-007-3) 쇼핑몰 주소 확인. GET ?slug=. 응답: { available, reason: "invalid"(형식·예약어) | "taken"(이미 쓰는 주소) | null }.
// 로그인 없이 쓰지만 쇼핑몰 주소는 공개 주소라 알려 줘도 새는 정보가 없다. 가입 때 다시 확인하므로(신청 slug_taken) 이 답은 참고용이다.
// 같은 접속 IP에서 1분에 30번까지, 넘으면 429 too_many_requests(MASTER 결정 2026-10-06).
export async function GET(req: Request) {
  try {
    if (!slugCheckAllowed(clientIp(req))) return noStore(NextResponse.json({ error: "too_many_requests", message: "잠시 뒤에 다시 확인해 주세요" }, { status: 429 }));
    const slug = new URL(req.url).searchParams.get("slug") ?? "";
    if (slug.length > 40) return noStore(NextResponse.json({ available: false, reason: "invalid" }));
    return noStore(NextResponse.json(await checkSlug(prisma, slug)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
