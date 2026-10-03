import { NextResponse } from "next/server";
import { loginAdmin } from "../../../../../lib/server/auth/login";
import { loginErrorBody } from "../../../../../lib/server/auth/messages";
import { prisma } from "../../../../../lib/server/db";
import { isString, loginFailureStatus, mutation, readJson, requestMeta, setSessionCookie } from "../../../../../lib/server/http/route";

export const POST = mutation(async (req: Request) => {
  const body = await readJson<{ email: string; password: string }>(req);
  if (!isString(body.email) || !isString(body.password)) return NextResponse.json(loginErrorBody("bad_request", "admin"), { status: 400 });
  const result = await loginAdmin(prisma, { email: body.email, password: body.password }, requestMeta(req));
  // 실패는 { error, message(화면 문구) }. 이메일·비밀번호 중 무엇이 틀렸는지는 구분하지 않는다.
  if (!result.ok) return NextResponse.json(loginErrorBody(result.reason, "admin"), { status: loginFailureStatus(result.reason) });
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, "admin", result.token, result.expiresAt);
  return res;
});
