import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken, setFlowCookie } from "../../../../../../lib/server/http/route";
import { START_IN_PROGRESS_MESSAGE } from "../../../../../../lib/server/identity/attempt";
import { identityFailure } from "../../../../../../lib/server/identity/http";
import { identityProvider, identityUnavailable } from "../../../../../../lib/server/identity/registry";
import { startStaffLink } from "../../../../../../lib/server/sellers/staffIdentity";
import { STAFF_LINK_IDV_COOKIE, STAFF_LINK_MESSAGES, STAFF_LINK_PATH } from "../../../../../../lib/server/sellers/staffIdentityFlow";

const NO_STORE = { "cache-control": "no-store" };

// 직원 본인확인 연결 시작(로그인한 직원만). 본문 { name, phone, birth7, carrier, device?, attemptKey? }.
// attemptKey(UUID)로 다시 보내면 같은 verificationId·같은 쿠키 값(문자·하루 횟수 다시 안 씀), 보내는 중이면 409 start_in_progress.
// 대표자가 등록한 휴대폰이 없으면 409 phone_not_registered, 입력한 이름·번호가 등록 정보와 다르면 409 identity_mismatch(문자 안 보냄),
// 직원 계정당 하루 10회를 넘으면 429 link_limit_exceeded. 성공하면 { verificationId }와 확인용 쿠키.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const body = await readJson<Record<string, unknown>>(req);
  const r = await startStaffLink(prisma, provider, ctx, body, { ...requestMeta(req), attemptKey: body.attemptKey });
  if (!r.ok) {
    if (r.reason === "phone_not_registered" || r.reason === "identity_mismatch") {
      return NextResponse.json({ error: r.reason, message: STAFF_LINK_MESSAGES[r.reason] }, { status: 409, headers: NO_STORE });
    }
    if (r.reason === "start_in_progress") return NextResponse.json({ error: r.reason, message: START_IN_PROGRESS_MESSAGE }, { status: 409, headers: NO_STORE });
    if (r.reason === "link_limit_exceeded") return NextResponse.json({ error: r.reason, message: STAFF_LINK_MESSAGES[r.reason] }, { status: 429, headers: NO_STORE });
    return identityFailure(r.reason);
  }
  const res = NextResponse.json({ verificationId: r.verificationId }, { headers: NO_STORE });
  setFlowCookie(res, STAFF_LINK_IDV_COOKIE, r.ownerToken, STAFF_LINK_PATH, 20 * 60);
  return res;
});
