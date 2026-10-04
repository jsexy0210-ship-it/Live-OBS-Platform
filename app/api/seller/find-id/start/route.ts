import { NextResponse } from "next/server";
import { startAccountRecovery } from "../../../../../lib/server/auth/accountRecovery";
import { FLOW_COOKIE_MAX_AGE_S } from "../../../../../lib/server/auth/passwordReset";
import { RECOVERY_IDV_COOKIE, RECOVERY_LIMIT_MESSAGE, RECOVERY_PATH } from "../../../../../lib/server/auth/recoveryFlow";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, setFlowCookie } from "../../../../../lib/server/http/route";
import { START_IN_PROGRESS_MESSAGE } from "../../../../../lib/server/identity/attempt";
import { identityFailure } from "../../../../../lib/server/identity/http";
import { identityProvider, identityUnavailable } from "../../../../../lib/server/identity/registry";

const NO_STORE = { "cache-control": "no-store" };

// 파트너스 아이디 찾기·계정 고르기 비밀번호 찾기 1단계(AU-011·AU-003): 본인 휴대폰 본인확인 시작.
// 본문 { name, phone, birth7, carrier, device?, attemptKey?, accountType? }(accountType은 받기만 하고 목록·재설정 때 다시 보낸다).
// 같은 휴대폰 하루 10회·같은 IP 하루 30회(비밀번호 찾기와 합산), 넘으면 429 recovery_limit_exceeded.
// attemptKey(UUID)로 다시 보내면 같은 verificationId·같은 쿠키 값(문자·횟수 다시 안 씀), 보내는 중이면 409 start_in_progress.
export const POST = mutation(async (req: Request) => {
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const body = await readJson<Record<string, unknown>>(req);
  const r = await startAccountRecovery(prisma, provider, body, { ...requestMeta(req), attemptKey: body.attemptKey });
  if (!r.ok) {
    if (r.reason === "recovery_limit_exceeded") return NextResponse.json({ error: r.reason, message: RECOVERY_LIMIT_MESSAGE }, { status: 429, headers: NO_STORE });
    if (r.reason === "start_in_progress") return NextResponse.json({ error: r.reason, message: START_IN_PROGRESS_MESSAGE }, { status: 409, headers: NO_STORE });
    return identityFailure(r.reason);
  }
  const res = NextResponse.json({ verificationId: r.verificationId }, { headers: NO_STORE });
  setFlowCookie(res, RECOVERY_IDV_COOKIE, r.ownerToken, RECOVERY_PATH, FLOW_COOKIE_MAX_AGE_S);
  return res;
});
