import { NextResponse } from "next/server";
import { SHOP_NOT_FOUND_MESSAGE } from "../../../../../../lib/server/auth/messages";
import { BUYER_SIGNUP_IDV_COOKIE, BUYER_SIGNUP_MESSAGES, buyerSignupPath, startBuyerSignupVerification } from "../../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readCookie, readJson, requestMeta, setFlowCookie } from "../../../../../../lib/server/http/route";
import { identityFailure } from "../../../../../../lib/server/identity/http";
import { identityProvider, identityUnavailable } from "../../../../../../lib/server/identity/registry";

const NO_STORE = { "cache-control": "no-store" };

// 구매자 가입 1단계: 휴대폰 본인확인 시작(같은 IP·같은 쇼핑몰 하루 10회까지). 본문 { name, phone, birth7, carrier, device?, attemptKey? }.
// attemptKey(UUID)를 보내면 응답이 끊겨 다시 보낸 요청은 같은 verificationId와 새 쿠키를 받는다(문자·횟수 다시 안 씀).
// 첫 인증번호를 보내고, 시작한 브라우저에만 확인용 쿠키를 준다(이 쇼핑몰 가입 경로에서만 보냄). 운영에 본인확인 설정이 없으면 503.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug }, select: { id: true, status: true } });
  if (!seller || seller.status !== "ACTIVE") return NextResponse.json({ error: "not_found", message: SHOP_NOT_FOUND_MESSAGE }, { status: 404, headers: NO_STORE });
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const body = await readJson<Record<string, unknown>>(req);
  const r = await startBuyerSignupVerification(prisma, provider, seller.id, body, {
    ...requestMeta(req),
    attemptKey: body.attemptKey,
    ownerToken: readCookie(req, BUYER_SIGNUP_IDV_COOKIE),
  });
  if (!r.ok) {
    if (r.reason === "daily_limit_exceeded") return NextResponse.json({ error: r.reason, message: BUYER_SIGNUP_MESSAGES.daily_limit_exceeded }, { status: 429, headers: NO_STORE });
    if (r.reason === "start_in_progress") return NextResponse.json({ error: r.reason, message: BUYER_SIGNUP_MESSAGES.start_in_progress }, { status: 409, headers: NO_STORE });
    if (r.reason === "shop_unavailable") return NextResponse.json({ error: r.reason, message: BUYER_SIGNUP_MESSAGES.shop_unavailable }, { status: 402, headers: NO_STORE });
    return identityFailure(r.reason);
  }
  const res = NextResponse.json({ verificationId: r.verificationId }, { headers: NO_STORE });
  setFlowCookie(res, BUYER_SIGNUP_IDV_COOKIE, r.ownerToken, buyerSignupPath(slug), 40 * 60);
  return res;
});
