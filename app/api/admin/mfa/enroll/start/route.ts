import { NextResponse } from "next/server";
import { startTotpEnrollment } from "../../../../../../lib/server/auth/mfaEnroll";
import { requireAdminEnrollment } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, sessionToken } from "../../../../../../lib/server/http/route";

// TOTP 등록 시작(등록 전용 세션만). 응답의 otpauthUri를 인증 앱에 등록한다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireAdminEnrollment(prisma, sessionToken(req, "admin"));
  return NextResponse.json(await startTotpEnrollment(prisma, ctx), { headers: { "cache-control": "no-store" } });
});
