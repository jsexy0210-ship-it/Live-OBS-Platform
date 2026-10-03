import type { IdentityVerificationPurpose } from "@prisma/client";
import { NextResponse } from "next/server";
import { BUYER_SIGNUP_MESSAGES, shopOpen } from "../buyers/signup";
import { prisma } from "../db";
import { mutation, readCookie, readJson } from "../http/route";
import { IDENTITY_ERROR_STATUS, identityErrorBody, type IdentityErrorCode } from "./messages";
import { identityProvider, identityUnavailable } from "./registry";
import { confirmIdentityCode, resendIdentityCode } from "./verification";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 본인확인 실패 응답(해요체 문구, 캐시 안 함)
export const identityFailure = (reason: IdentityErrorCode) =>
  NextResponse.json(identityErrorBody(reason), { status: IDENTITY_ERROR_STATUS[reason], headers: { "cache-control": "no-store" } });

// 인증번호 다시 보내기·확인 라우트. 본문 { verificationId, code? }. 시작한 브라우저의 쿠키(cookieName)가 있어야 한다.
// 쇼핑몰(sellerId)은 요청 기록에서 읽고, ownerToken·용도가 맞아야만 쓴다(다른 세션의 요청 id는 없는 것으로 본다).
// 쇼핑몰 경로(/api/shop/{slug}/…)에서 쓰면 URL의 쇼핑몰이 기록의 쇼핑몰과 같아야 하고(다르면 404),
// 운영 중·잠기지 않은 쇼핑몰이어야 한다(잠기면 402, 가입 시작과 같은 기준).
export function identityStepRoute(step: "resend" | "confirm", purpose: IdentityVerificationPurpose, cookieName: string) {
  return mutation(async (req: Request, ctx?: { params: Promise<{ slug?: string }> }) => {
    const provider = identityProvider();
    if (!provider) return identityUnavailable();
    const body = await readJson<{ verificationId: string; code: string }>(req);
    const id = typeof body.verificationId === "string" && UUID.test(body.verificationId) ? body.verificationId : null;
    if (!id) return identityFailure("not_found");
    const v = await prisma.identityVerification.findUnique({ where: { id }, select: { sellerId: true } });
    if (!v) return identityFailure("not_found");
    const slug = ctx ? (await ctx.params).slug : undefined;
    if (slug !== undefined) {
      const shop = await prisma.seller.findUnique({ where: { slug }, select: { id: true } });
      if (!shop || shop.id !== v.sellerId) return identityFailure("not_found");
      if (!(await shopOpen(prisma, shop.id))) {
        return NextResponse.json({ error: "shop_unavailable", message: BUYER_SIGNUP_MESSAGES.shop_unavailable }, { status: 402, headers: { "cache-control": "no-store" } });
      }
    }
    const owner = { sellerId: v.sellerId, purpose, ownerToken: readCookie(req, cookieName) };
    if (step === "resend") {
      const r = await resendIdentityCode(prisma, provider, id, owner);
      if (!r.ok) return identityFailure(r.reason);
      return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    }
    const r = await confirmIdentityCode(prisma, provider, id, owner, body.code);
    if (!r.ok) return identityFailure(r.reason);
    // 구매자 가입 확인 성공이면 저장된 본인확인 결과를 돌려준다(시작한 브라우저에만 가는 응답). 화면은 이 값을 본인확인 결과로 보여 준다.
    if (purpose === "BUYER_SIGNUP") {
      const { name, phone, birthDate } = r.verification;
      return NextResponse.json(
        { ok: true, identity: { name, phone, birthDate: birthDate ? birthDate.toISOString().slice(0, 10) : null } },
        { headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  });
}
