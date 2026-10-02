import { NextResponse } from "next/server";
import { GRANT_COOKIE, IDV_COOKIE, RESET_PATH, issueSellerPasswordResetGrant } from "../../../../../lib/server/auth/passwordReset";
import { prisma } from "../../../../../lib/server/db";
import { clearFlowCookie, isString, mutation, readCookie, readJson, requestMeta, setFlowCookie } from "../../../../../lib/server/http/route";
import { identityProvider } from "../../../../../lib/server/identity/registry";

// PASS 완료 뒤 호출. 시작한 브라우저(lo_idv 쿠키)만 쓸 수 있고, 대표자 CI가 맞으면 10분짜리 재설정 권한을 쿠키로 준다.
export const POST = mutation(async (req: Request) => {
  const body = await readJson<{ verificationId: string }>(req);
  if (!isString(body.verificationId)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const r = await issueSellerPasswordResetGrant(
    prisma,
    identityProvider(),
    { verificationId: body.verificationId, ownerToken: readCookie(req, IDV_COOKIE) },
    requestMeta(req),
  );
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "pending" ? 409 : 400 });
  const res = NextResponse.json({ ok: true });
  clearFlowCookie(res, IDV_COOKIE, RESET_PATH);
  setFlowCookie(res, GRANT_COOKIE, r.grantToken, RESET_PATH, 10 * 60);
  return res;
});
