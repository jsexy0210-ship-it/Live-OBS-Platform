import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { mutation, readJson, requestMeta, setFlowCookie } from "../../../../lib/server/http/route";
import { START_IN_PROGRESS_MESSAGE } from "../../../../lib/server/identity/attempt";
import { identityFailure } from "../../../../lib/server/identity/http";
import { identityProvider, identityUnavailable } from "../../../../lib/server/identity/registry";
import { startSellerSignupVerification } from "../../../../lib/server/sellers/application";
import { SELLER_SIGNUP_IDV_COOKIE, SELLER_SIGNUP_PATH } from "../../../../lib/server/sellers/signupFlow";

// 판매자 가입 신청 1단계: 대표자 휴대폰 본인확인 시작(같은 IP 하루 10회까지). 본문 { name, phone, birth7, carrier, device?, attemptKey? }.
// attemptKey(UUID)를 보내면 응답이 끊겨 다시 보낸 요청은 같은 verificationId와 같은 쿠키 값을 받는다(문자·횟수 다시 안 씀).
// 같은 키의 첫 문자를 보내는 중이면 409 start_in_progress, 그 기록이 이미 확인됐거나 끝났으면 already_verified·expired·failed.
// 첫 인증번호를 보내고, 시작한 브라우저에만 확인용 쿠키를 준다. 운영에 본인확인 설정이 없으면 503.
export const POST = mutation(async (req: Request) => {
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const body = await readJson<Record<string, unknown>>(req);
  const r = await startSellerSignupVerification(prisma, provider, body, { ...requestMeta(req), attemptKey: body.attemptKey });
  if (!r.ok) {
    if (r.reason === "daily_limit_exceeded") return NextResponse.json({ error: r.reason }, { status: 429, headers: { "cache-control": "no-store" } });
    if (r.reason === "start_in_progress") return NextResponse.json({ error: r.reason, message: START_IN_PROGRESS_MESSAGE }, { status: 409, headers: { "cache-control": "no-store" } });
    return identityFailure(r.reason);
  }
  const res = NextResponse.json({ verificationId: r.verificationId }, { headers: { "cache-control": "no-store" } });
  setFlowCookie(res, SELLER_SIGNUP_IDV_COOKIE, r.ownerToken, SELLER_SIGNUP_PATH, 40 * 60);
  return res;
});
