import { NextResponse } from "next/server";
import { revokeSession } from "../../../../../lib/server/auth/session";
import { prisma } from "../../../../../lib/server/db";
import { assertSameOrigin, clearSessionCookie, errorResponse, sessionToken } from "../../../../../lib/server/http/route";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    await revokeSession(prisma, "seller", sessionToken(req, "seller"));
    const res = NextResponse.json({ ok: true });
    clearSessionCookie(res, "seller");
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
