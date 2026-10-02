import { NextResponse } from "next/server";
import { loginAdmin } from "../../../../../lib/server/auth/login";
import { prisma } from "../../../../../lib/server/db";
import { isString, loginFailureStatus, mutation, readJson, requestMeta, setSessionCookie } from "../../../../../lib/server/http/route";

// 2단계 인증을 등록한 마스터는 totpCode를 함께 보낸다. 등록 전이면 등록 전용 세션을 받고 mfaEnrollmentRequired가 true다.
export const POST = mutation(async (req: Request) => {
  const body = await readJson<{ email: string; password: string; totpCode: string }>(req);
  if (!isString(body.email) || !isString(body.password)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await loginAdmin(
    prisma,
    { email: body.email, password: body.password, totpCode: isString(body.totpCode) ? body.totpCode : undefined },
    requestMeta(req),
  );
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: loginFailureStatus(result.reason) });
  const res = NextResponse.json({ ok: true, mfaEnrollmentRequired: !!result.mfaEnrollmentRequired });
  setSessionCookie(res, "admin", result.token, result.expiresAt);
  return res;
});
