import { NextResponse } from "next/server";
import { loginAdmin } from "../../../../../lib/server/auth/login";
import { prisma } from "../../../../../lib/server/db";
import { isString, loginFailureStatus, mutation, readJson, requestMeta, setSessionCookie } from "../../../../../lib/server/http/route";

export const POST = mutation(async (req: Request) => {
  const body = await readJson<{ email: string; password: string }>(req);
  if (!isString(body.email) || !isString(body.password)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await loginAdmin(prisma, { email: body.email, password: body.password }, requestMeta(req));
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: loginFailureStatus(result.reason) });
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, "admin", result.token, result.expiresAt);
  return res;
});
