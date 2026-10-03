import { NextResponse } from "next/server";
import { loginBuyer } from "../../../../../lib/server/auth/login";
import { SHOP_NOT_FOUND_MESSAGE } from "../../../../../lib/server/auth/messages";
import { BUYER_SIGNUP_IDV_COOKIE, BUYER_SIGNUP_MESSAGES, BUYER_SIGNUP_STATUS, signupBuyer } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readCookie, readJson, requestMeta, setSessionCookie } from "../../../../../lib/server/http/route";
import { identityProvider, identityUnavailable } from "../../../../../lib/server/identity/registry";

const NO_STORE = { "cache-control": "no-store" };
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : "");
// 아이디(이메일)는 길이를 잘라 보지 않고 그대로 넘겨 signupBuyer가 앞뒤 공백을 지운 254자 기준으로 검사한다(로그인과 같은 기준)
const raw = (v: unknown) => (typeof v === "string" && v.length <= 4096 ? v : "");

// 구매자 가입 2단계: 휴대폰 본인확인을 마친 브라우저에서 가입. 본문 { verificationId, loginId, password, broadcastNickname,
// agreedTerms: true, agreedPrivacy: true, agreedMarketing?: boolean(선택, 기본 false), agreedRejoinRetention?: boolean(재가입 제한을 켠 쇼핑몰은 필수) }. 이름·휴대폰·생년월일은 본인확인 결과를 쓴다. 가입하면 바로 로그인된다(세션 쿠키).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug }, select: { id: true, status: true } });
  if (!seller || seller.status !== "ACTIVE") return NextResponse.json({ error: "not_found", message: SHOP_NOT_FOUND_MESSAGE }, { status: 404, headers: NO_STORE });
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const body = await readJson<Record<string, unknown>>(req);
  const r = await signupBuyer(prisma, provider, {
    sellerId: seller.id,
    verificationId: str(body.verificationId, 36),
    ownerToken: readCookie(req, BUYER_SIGNUP_IDV_COOKIE),
    loginId: raw(body.loginId),
    password: str(body.password, 400),
    broadcastNickname: str(body.broadcastNickname, 200),
    agreedTerms: body.agreedTerms === true,
    agreedPrivacy: body.agreedPrivacy === true,
    agreedMarketing: body.agreedMarketing,
    agreedRejoinRetention: body.agreedRejoinRetention,
    meta: requestMeta(req),
  });
  if (!r.ok) {
    // 재가입 제한 중이면 다시 가입할 수 있는 시각(ISO)을 함께 준다. 화면이 「…부터 가입할 수 있어요」를 붙인다(SH-011).
    const extra = r.rejoinAvailableAt ? { rejoinAvailableAt: r.rejoinAvailableAt.toISOString() } : {};
    return NextResponse.json({ error: r.reason, message: BUYER_SIGNUP_MESSAGES[r.reason], ...extra }, { status: BUYER_SIGNUP_STATUS[r.reason], headers: NO_STORE });
  }
  const res = NextResponse.json({ ok: true, broadcastNickname: r.broadcastNickname }, { status: 201, headers: NO_STORE });
  // 본인확인 쿠키(lo_bidv)는 지우지 않는다. 응답 헤더만 도착하고 본문이 끊겨도 같은 가입 요청을 다시 보내 같은 회원을 받을 수 있게.
  // 본인확인은 이미 소진되어 재전송에만 쓰이고, 쓸 수 있는 시간(확인 뒤 10분)이 지나면 쓸모가 없다(쿠키는 시작 때 40분).
  // 가입한 아이디·비밀번호로 바로 로그인한다(로그인 실패 감사 등 기존 규칙 그대로)
  const login = await loginBuyer(prisma, { sellerId: seller.id, loginId: raw(body.loginId), password: str(body.password, 400) }, requestMeta(req));
  if (login.ok) setSessionCookie(res, "buyer", login.token, login.expiresAt);
  return res;
});
