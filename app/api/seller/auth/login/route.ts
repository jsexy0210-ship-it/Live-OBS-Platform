import { NextResponse } from "next/server";
import { loginSeller } from "../../../../../lib/server/auth/login";
import { loginErrorBody } from "../../../../../lib/server/auth/messages";
import { prisma } from "../../../../../lib/server/db";
import { isString, loginFailureStatus, mutation, readJson, requestMeta, setSessionCookie } from "../../../../../lib/server/http/route";

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
  if (!result.ok) return NextResponse.json(loginErrorBody(result.reason), { status: loginFailureStatus(result.reason) });
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, "seller", result.token, result.expiresAt);
  return res;
});
