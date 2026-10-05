import { NextResponse } from "next/server";
import { revokeSession } from "../../../../../lib/server/auth/session";
import { prisma } from "../../../../../lib/server/db";
import { COOKIE_NAMES } from "../../../../../lib/server/auth/policy";
import { clearImpersonationCookie, clearSessionCookie, mutation, readCookie } from "../../../../../lib/server/http/route";

export const POST = mutation(async (req: Request) => {
  await revokeSession(prisma, "seller", readCookie(req, COOKIE_NAMES.seller));
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res, "seller");
  clearImpersonationCookie(res);
  return res;
});
