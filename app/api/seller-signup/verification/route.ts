import { NextResponse } from "next/server";
import { prisma } from "../../../../lib/server/db";
import { mutation, setFlowCookie } from "../../../../lib/server/http/route";
import { identityProvider } from "../../../../lib/server/identity/registry";
import { startIdentityVerification } from "../../../../lib/server/identity/verification";
import { SELLER_SIGNUP_IDV_COOKIE, SELLER_SIGNUP_PATH } from "../../../../lib/server/sellers/signupFlow";

// 판매자 가입 신청 1단계: 대표자 PASS 본인인증 시작. 시작한 브라우저에만 확인용 쿠키를 준다.
export const POST = mutation(async () => {
  const { verification, ownerToken } = await startIdentityVerification(prisma, identityProvider(), { purpose: "SELLER_REPRESENTATIVE", sellerId: null });
  const res = NextResponse.json({ verificationId: verification.id, requestId: verification.requestId }, { headers: { "cache-control": "no-store" } });
  setFlowCookie(res, SELLER_SIGNUP_IDV_COOKIE, ownerToken, SELLER_SIGNUP_PATH, 40 * 60);
  return res;
});
