import type { IdentityVerificationPurpose } from "@prisma/client";
import { NextResponse } from "next/server";
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
export function identityStepRoute(step: "resend" | "confirm", purpose: IdentityVerificationPurpose, cookieName: string) {
  return mutation(async (req: Request) => {
    const provider = identityProvider();
    if (!provider) return identityUnavailable();
    const body = await readJson<{ verificationId: string; code: string }>(req);
    const id = typeof body.verificationId === "string" && UUID.test(body.verificationId) ? body.verificationId : null;
    if (!id) return identityFailure("not_found");
    const v = await prisma.identityVerification.findUnique({ where: { id }, select: { sellerId: true } });
    if (!v) return identityFailure("not_found");
    const owner = { sellerId: v.sellerId, purpose, ownerToken: readCookie(req, cookieName) };
    const r = step === "resend" ? await resendIdentityCode(prisma, provider, id, owner) : await confirmIdentityCode(prisma, provider, id, owner, body.code);
    if (!r.ok) return identityFailure(r.reason);
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  });
}
