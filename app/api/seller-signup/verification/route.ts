import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { mutation, requestMeta, setFlowCookie } from "../../../../lib/server/http/route";
import { identityProvider } from "../../../../lib/server/identity/registry";
import { startSellerSignupVerification } from "../../../../lib/server/sellers/application";
import { SELLER_SIGNUP_IDV_COOKIE, SELLER_SIGNUP_PATH } from "../../../../lib/server/sellers/signupFlow";

// 판매자 가입 신청 1단계: 대표자 PASS 본인인증 시작(같은 IP 하루 10회까지). 시작한 브라우저에만 확인용 쿠키를 준다.
export const POST = mutation(async (req: Request) => {
  const r = await startSellerSignupVerification(prisma, identityProvider(), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 429 });
  const res = NextResponse.json({ verificationId: r.verificationId, requestId: r.requestId }, { headers: { "cache-control": "no-store" } });
  setFlowCookie(res, SELLER_SIGNUP_IDV_COOKIE, r.ownerToken, SELLER_SIGNUP_PATH, 40 * 60);
  return res;
});
