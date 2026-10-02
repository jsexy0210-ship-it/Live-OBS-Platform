import { NextResponse } from "next/server";
import { loginSeller } from "../../../../../lib/server/auth/login";
import { prisma } from "../../../../../lib/server/db";
import { assertSameOrigin, errorResponse, isString, loginFailureStatus, readJson, requestMeta, setSessionCookie } from "../../../../../lib/server/http/route";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const body = await readJson<{ email: string; password: string; shopSlug: string }>(req);
    if (!isString(body.email) || !isString(body.password)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const result = await loginSeller(
      prisma,
      { email: body.email, password: body.password, shopSlug: isString(body.shopSlug) ? body.shopSlug : undefined },
      requestMeta(req),
    );
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: loginFailureStatus(result.reason) });
    const res = NextResponse.json({ ok: true });
    setSessionCookie(res, "seller", result.token, result.expiresAt);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
