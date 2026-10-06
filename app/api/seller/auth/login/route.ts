import { NextResponse } from "next/server";
import { loginSeller } from "../../../../../lib/server/auth/login";
import { PENDING_ACCESS_COOKIE, PENDING_ACCESS_PATH, issuePendingToken } from "../../../../../lib/server/sellers/pendingAccess";
import { loginErrorBody } from "../../../../../lib/server/auth/messages";
import { prisma } from "../../../../../lib/server/db";
import { clearImpersonationCookie, isString, loginFailureStatus, mutation, readJson, requestMeta, setSessionCookie } from "../../../../../lib/server/http/route";

export const POST = mutation(async (req: Request) => {
  const body = await readJson<{ email: string; password: string; shopSlug: string; accountType?: unknown }>(req);
  if (!isString(body.email) || !isString(body.password)) return NextResponse.json(loginErrorBody("bad_request"), { status: 400 });
  // accountType: 로그인 탭(owner|staff). 빠지면 종류를 보지 않고, 그 밖의 값은 400.
  if (body.accountType !== undefined && body.accountType !== "owner" && body.accountType !== "staff") return NextResponse.json(loginErrorBody("bad_request"), { status: 400 });
  const result = await loginSeller(
    prisma,
    { email: body.email, password: body.password, shopSlug: isString(body.shopSlug) ? body.shopSlug : undefined, accountType: body.accountType },
    requestMeta(req),
  );
  // 실패는 { error, message(화면 문구) }. 이메일·비밀번호 중 무엇이 틀렸는지는 구분하지 않는다.
  // wrong_account_type(409): 비밀번호는 맞았지만 고른 탭과 계정 종류가 다르다(세션 없음). 화면이 맞는 탭으로 안내한다.
  if (!result.ok) {
    // 승인 대기·반려 대표자: 로그인은 막지만 신청 안내(AU-005)용 15분 쿠키를 준다. 화면은 application으로 안내 화면에 보낸다
    const res = NextResponse.json({ ...loginErrorBody(result.reason), ...(result.pendingGrant ? { application: result.pendingGrant.application } : {}) }, { status: loginFailureStatus(result.reason) });
    if (result.pendingGrant) {
      const { token, expiresAt } = issuePendingToken(result.pendingGrant);
      res.cookies.set(PENDING_ACCESS_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: PENDING_ACCESS_PATH, expires: expiresAt });
    }
    return res;
  }
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, "seller", result.token, result.expiresAt);
  // 같은 브라우저에 마스터 대리 조회 쿠키가 남아 있으면 지운다(남기면 로그인한 뒤에도 대리 조회 화면이 우선한다)
  clearImpersonationCookie(res);
  return res;
});
