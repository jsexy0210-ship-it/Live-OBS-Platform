import { NextResponse } from "next/server";
import { IDV_COOKIE, RESET_PATH, startSellerPasswordReset } from "../../../../../lib/server/auth/passwordReset";
import { prisma } from "../../../../../lib/server/db";
import { isString, mutation, readJson, requestMeta, setFlowCookie } from "../../../../../lib/server/http/route";
import { identityFailure } from "../../../../../lib/server/identity/http";
import { identityProvider, identityUnavailable } from "../../../../../lib/server/identity/registry";

// 판매자 비밀번호 찾기 시작(이메일+쇼핑몰 + 대표자 인적사항 { name, phone, birth7, carrier }). 계정 유무와 상관없이 같은 응답이고,
// 첫 인증번호를 보낸다. 운영에 본인확인 설정이 없으면 503.
export const POST = mutation(async (req: Request) => {
  const provider = identityProvider();
  if (!provider) return identityUnavailable();
  const body = await readJson<{ email: string; shopSlug: string; person: unknown }>(req);
  if (!isString(body.email) || !isString(body.shopSlug)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const r = await startSellerPasswordReset(prisma, provider, { email: body.email, shopSlug: body.shopSlug, person: body.person }, requestMeta(req));
  if (!r.ok) {
    if (r.reason === "reset_limit_exceeded") return NextResponse.json({ error: r.reason }, { status: 429, headers: { "cache-control": "no-store" } });
    return identityFailure(r.reason);
  }
  const res = NextResponse.json({ verificationId: r.verificationId }, { headers: { "cache-control": "no-store" } });
  setFlowCookie(res, IDV_COOKIE, r.ownerToken, RESET_PATH, 10 * 60);
  return res;
});
