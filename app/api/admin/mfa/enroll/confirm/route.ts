import { NextResponse } from "next/server";
import { confirmTotpEnrollment } from "../../../../../../lib/server/auth/mfaEnroll";
import { requireAdminEnrollment } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { isString, mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// TOTP 등록 확인. 성공하면 지금 세션이 2단계 인증을 마친 세션이 된다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireAdminEnrollment(prisma, sessionToken(req, "admin"));
  const body = await readJson<{ code: string }>(req);
  if (!isString(body.code)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const r = await confirmTotpEnrollment(prisma, ctx, body.code, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "locked" ? 429 : 400 });
  return NextResponse.json({ ok: true });
});
