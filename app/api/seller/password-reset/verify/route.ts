import { NextResponse } from "next/server";
import { GRANT_COOKIE, IDV_COOKIE, RESET_PATH, issueSellerPasswordResetGrant } from "../../../../../lib/server/auth/passwordReset";
import { prisma } from "../../../../../lib/server/db";
import { clearFlowCookie, isString, mutation, readCookie, readJson, requestMeta, setFlowCookie } from "../../../../../lib/server/http/route";
import { identityProvider } from "../../../../../lib/server/identity/registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PASS 완료 뒤 호출. 시작한 브라우저(lo_idv 쿠키)만 쓸 수 있고, 대표자 CI가 맞으면 10분짜리 재설정 권한을 쿠키로 준다.
export const POST = mutation(async (req: Request) => {
  const body = await readJson<{ verificationId: string }>(req);
  // 형식이 틀린 id도 다른 거부와 같은 응답(존재 여부 비노출)
  if (!isString(body.verificationId) || !UUID.test(body.verificationId)) {
    return NextResponse.json({ error: "reset_not_allowed" }, { status: 400 });
  }
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
