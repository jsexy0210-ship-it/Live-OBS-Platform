import { NextResponse } from "next/server";
import { BUYER_PHONE_CHANGE_IDV_COOKIE, PHONE_CHANGE_MESSAGES, PHONE_CHANGE_STATUS, applyBuyerPhoneChange } from "../../../../../../lib/server/buyers/phoneChange";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readCookie, readJson, requestMeta } from "../../../../../../lib/server/http/route";
import { identityProvider, identityUnavailable } from "../../../../../../lib/server/identity/registry";

// 구매자 휴대폰 번호 변경 마지막 단계(SH-024): 인증번호 확인을 마친 본인확인으로 번호(와 생년월일)를 바꾼다. 본문 { verificationId }.
// 새 번호 본인확인의 CI가 회원의 CI와 다르면 403 identity_mismatch, 확인 전이면 409 verification_pending, 쓸 수 없는 본인확인이면 400 verification_invalid,
// 다른 회원이 쓰는 번호면 409 phone_taken. 바꿔도 다른 기기의 로그인은 그대로다. 성공 → { ok: true }.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const body = await readJson<{ verificationId: unknown }>(req);
  const r = await applyBuyerPhoneChange(prisma, provider, b.scope, { verificationId: body.verificationId, ownerToken: readCookie(req, BUYER_PHONE_CHANGE_IDV_COOKIE) }, requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: PHONE_CHANGE_MESSAGES[r.reason] }, { status: PHONE_CHANGE_STATUS[r.reason] }));
  return noStore(NextResponse.json({ ok: true }));
});
