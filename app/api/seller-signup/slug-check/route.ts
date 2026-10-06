import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../lib/server/http/route";
import { checkSlug } from "../../../../lib/server/sellers/signupAssist";

// 파트너스 가입(PF-007-3) 쇼핑몰 주소 확인. GET ?slug=. 응답: { available, reason: "invalid"(형식·예약어) | "taken"(이미 쓰는 주소) | null }.
// 로그인 없이 쓰지만 쇼핑몰 주소는 공개 주소라 알려 줘도 새는 정보가 없다. 가입 때 다시 확인하므로(신청 slug_taken) 이 답은 참고용이다.
export async function GET(req: Request) {
  try {
    const slug = new URL(req.url).searchParams.get("slug") ?? "";
    if (slug.length > 40) return noStore(NextResponse.json({ available: false, reason: "invalid" }));
    return noStore(NextResponse.json(await checkSlug(prisma, slug)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
