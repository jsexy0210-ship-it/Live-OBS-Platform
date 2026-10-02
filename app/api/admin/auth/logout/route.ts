import { NextResponse } from "next/server";
import { revokeSession } from "../../../../../lib/server/auth/session";
import { prisma } from "../../../../../lib/server/db";
import { clearSessionCookie, mutation, sessionToken } from "../../../../../lib/server/http/route";

export const POST = mutation(async (req: Request) => {
  await revokeSession(prisma, "admin", sessionToken(req, "admin"));
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res, "admin");
  return res;
});
