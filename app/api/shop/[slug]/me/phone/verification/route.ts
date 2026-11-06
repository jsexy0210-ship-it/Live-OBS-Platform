import { NextResponse } from "next/server";
import { BUYER_PHONE_CHANGE_IDV_COOKIE, PHONE_CHANGE_MESSAGES, PHONE_CHANGE_STATUS, buyerPhoneChangePath, startBuyerPhoneChange } from "../../../../../../../lib/server/buyers/phoneChange";
import { buyerScope } from "../../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, setFlowCookie } from "../../../../../../../lib/server/http/route";
import { identityFailure } from "../../../../../../../lib/server/identity/http";
import { identityProvider, identityUnavailable } from "../../../../../../../lib/server/identity/registry";

// 구매자 휴대폰 번호 변경 1단계(SH-024): 새 번호로 본인확인 시작. 본문 { name, phone, birth7, carrier, device? }. 로그인한 회원만, 회원당 하루(KST) 3번까지.
// 첫 인증번호를 보내고 시작한 브라우저에만 확인용 쿠키를 준다. 성공 → { verificationId }.
// 지금 번호와 같으면 409 same_phone, 하루 한도를 넘으면 429 daily_limit_exceeded, 체험이 아닌데 충전금이 없거나 충전 기능이 꺼져 있으면 503 phone_change_unavailable.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const r = await startBuyerPhoneChange(prisma, provider, b.scope, await readJson(req), requestMeta(req));
  if (!r.ok) {
    if (r.reason in PHONE_CHANGE_MESSAGES) {
      const reason = r.reason as keyof typeof PHONE_CHANGE_MESSAGES;
      return noStore(NextResponse.json({ error: reason, message: PHONE_CHANGE_MESSAGES[reason] }, { status: PHONE_CHANGE_STATUS[reason] }));
    }
    return identityFailure(r.reason as "invalid_identity_input" | "provider_error");
  }
  const res = noStore(NextResponse.json({ verificationId: r.verificationId }));
  setFlowCookie(res, BUYER_PHONE_CHANGE_IDV_COOKIE, r.ownerToken, buyerPhoneChangePath(slug), 40 * 60);
  return res;
});
