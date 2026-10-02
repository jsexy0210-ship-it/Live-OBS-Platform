import { NextResponse } from "next/server";
import { GRANT_COOKIE, RESET_PATH, resetSellerPassword } from "../../../../../lib/server/auth/passwordReset";
import { prisma } from "../../../../../lib/server/db";
import { clearFlowCookie, mutation, readCookie, readJson, requestMeta } from "../../../../../lib/server/http/route";

// 새 비밀번호 저장. 재설정 권한은 한 번만 쓰이고, 그 계정의 기존 로그인은 모두 끊긴다.
export const POST = mutation(async (req: Request) => {
  const body = await readJson<{ newPassword: string }>(req);
  if (typeof body.newPassword !== "string" || body.newPassword.length > 200) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const r = await resetSellerPassword(prisma, { grantToken: readCookie(req, GRANT_COOKIE), newPassword: body.newPassword }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 400 });
  const res = NextResponse.json({ ok: true });
  clearFlowCookie(res, GRANT_COOKIE, RESET_PATH);
  return res;
});
