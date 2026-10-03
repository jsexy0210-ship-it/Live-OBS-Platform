import { NextResponse } from "next/server";
import { issueRecoveryResetGrant } from "../../../../../lib/server/auth/accountRecovery";
import { GRANT_COOKIE, RESET_PATH } from "../../../../../lib/server/auth/passwordReset";
import { RECOVERY_IDV_COOKIE, parseAccountType } from "../../../../../lib/server/auth/recoveryFlow";
import { prisma } from "../../../../../lib/server/db";
import { isString, mutation, readCookie, readJson, requestMeta, setFlowCookie } from "../../../../../lib/server/http/route";
import { identityProvider, identityUnavailable } from "../../../../../lib/server/identity/registry";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };

// 계정 고르기 비밀번호 찾기(AU-003): 본문 { verificationId, accountType, accountId }(accounts 목록의 하나).
// 고른 계정이 그 목록에 있으면 10분짜리 재설정 권한을 비밀번호 찾기와 같은 쿠키(lo_pwreset)로 주고, 새 비밀번호는
// POST /api/seller/password-reset/complete로 저장한다. 본인확인은 소진된다. 아니면 400 recovery_not_allowed.
// 응답을 잃어 같은 본인확인·같은 계정으로 소진 뒤 10분 안에 다시 보내면 새 권한을 주고 이전 권한은 무효로 바꾼다.
export const POST = mutation(async (req: Request) => {
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const body = await readJson<{ verificationId: unknown; accountType: unknown; accountId: unknown }>(req);
  const accountType = parseAccountType(body.accountType);
  if (!accountType) return NextResponse.json({ error: "bad_request" }, { status: 400, headers: NO_STORE });
  if (!isString(body.verificationId) || !UUID.test(body.verificationId) || !isString(body.accountId) || !UUID.test(body.accountId)) {
    return NextResponse.json({ error: "recovery_not_allowed" }, { status: 400, headers: NO_STORE });
  }
  const r = await issueRecoveryResetGrant(
    prisma,
    provider,
    { verificationId: body.verificationId, ownerToken: readCookie(req, RECOVERY_IDV_COOKIE), accountType, accountId: body.accountId },
    requestMeta(req),
  );
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "pending" ? 409 : 400, headers: NO_STORE });
  // 흐름 쿠키는 지우지 않는다: 응답을 잃으면 같은 쿠키로 10분 안에 다시 요청해 새 권한을 받는다(이전 권한은 무효, accountRecovery.ts)
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  setFlowCookie(res, GRANT_COOKIE, r.grantToken, RESET_PATH, 10 * 60);
  return res;
});
