import { NextResponse } from "next/server";
import { revokeSession } from "../../../../../../lib/server/auth/session";
import { prisma } from "../../../../../../lib/server/db";
import { assertSameOrigin, clearSessionCookie, errorResponse, sessionToken } from "../../../../../../lib/server/http/route";

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    await revokeSession(prisma, "buyer", sessionToken(req, "buyer"));
    const res = NextResponse.json({ ok: true });
    clearSessionCookie(res, "buyer");
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
