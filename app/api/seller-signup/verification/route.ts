import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { mutation, readJson, requestMeta, setFlowCookie } from "../../../../lib/server/http/route";
import { identityFailure } from "../../../../lib/server/identity/http";
import { identityProvider, identityUnavailable } from "../../../../lib/server/identity/registry";
import { startSellerSignupVerification } from "../../../../lib/server/sellers/application";
import { SELLER_SIGNUP_IDV_COOKIE, SELLER_SIGNUP_PATH } from "../../../../lib/server/sellers/signupFlow";

// 판매자 가입 신청 1단계: 대표자 휴대폰 본인확인 시작(같은 IP 하루 10회까지). 본문 { name, phone, birth7, carrier }.
// 첫 인증번호를 보내고, 시작한 브라우저에만 확인용 쿠키를 준다. 운영에 본인확인 설정이 없으면 503.
export const POST = mutation(async (req: Request) => {
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const r = await startSellerSignupVerification(prisma, provider, await readJson(req), requestMeta(req));
  if (!r.ok) {
    if (r.reason === "daily_limit_exceeded") return NextResponse.json({ error: r.reason }, { status: 429, headers: { "cache-control": "no-store" } });
    return identityFailure(r.reason);
  }
  const res = NextResponse.json({ verificationId: r.verificationId }, { headers: { "cache-control": "no-store" } });
  setFlowCookie(res, SELLER_SIGNUP_IDV_COOKIE, r.ownerToken, SELLER_SIGNUP_PATH, 40 * 60);
  return res;
});
