import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { clearFlowCookie, isString, mutation, readCookie, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { identityProvider, identityUnavailable } from "../../../../../../lib/server/identity/registry";
import { linkStaffIdentity } from "../../../../../../lib/server/sellers/staffIdentity";
import { STAFF_LINK_IDV_COOKIE, STAFF_LINK_MESSAGES, STAFF_LINK_PATH } from "../../../../../../lib/server/sellers/staffIdentityFlow";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_STORE = { "cache-control": "no-store" };

// 직원 본인확인 연결 마치기(본문 { verificationId }): 결과 이름·휴대폰이 등록 정보와 같으면 연결(200 { ok: true }),
// 다르면 409 identity_mismatch(연결 안 함), 확인 전이면 409 verification_pending, 쓸 수 없는 본인확인이면 400 verification_invalid.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const body = await readJson<{ verificationId: unknown }>(req);
  if (!isString(body.verificationId) || !UUID.test(body.verificationId)) {
    return NextResponse.json({ error: "verification_invalid", message: STAFF_LINK_MESSAGES.verification_invalid }, { status: 400, headers: NO_STORE });
  }
  const r = await linkStaffIdentity(prisma, provider, ctx, { verificationId: body.verificationId, ownerToken: readCookie(req, STAFF_LINK_IDV_COOKIE) }, requestMeta(req));
  if (!r.ok) {
    if (r.reason === "pending") return NextResponse.json({ error: "verification_pending" }, { status: 409, headers: NO_STORE });
    const res = NextResponse.json({ error: r.reason, message: STAFF_LINK_MESSAGES[r.reason] }, { status: r.reason === "identity_mismatch" ? 409 : 400, headers: NO_STORE });
    if (r.reason === "identity_mismatch") clearFlowCookie(res, STAFF_LINK_IDV_COOKIE, STAFF_LINK_PATH);
    return res;
  }
  const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
  clearFlowCookie(res, STAFF_LINK_IDV_COOKIE, STAFF_LINK_PATH);
  return res;
});
