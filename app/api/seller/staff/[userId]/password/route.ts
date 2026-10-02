import { NextResponse } from "next/server";
import { resetStaffPassword } from "../../../../../../lib/server/auth/passwordReset";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 대표가 직원 비밀번호를 재설정한다(같은 쇼핑몰 직원만). 직원의 기존 로그인은 모두 끊긴다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ userId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const { userId } = await params;
  if (!UUID.test(userId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ newPassword: string }>(req);
  if (typeof body.newPassword !== "string" || body.newPassword.length > 200) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const r = await resetStaffPassword(prisma, ctx, { staffUserId: userId, newPassword: body.newPassword }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  return NextResponse.json({ ok: true });
});
