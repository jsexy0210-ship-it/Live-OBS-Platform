import { NextResponse } from "next/server";
import { IDV_COOKIE, RESET_PATH, startSellerPasswordReset } from "../../../../../lib/server/auth/passwordReset";
import { prisma } from "../../../../../lib/server/db";
import { isString, mutation, readJson, requestMeta, setFlowCookie } from "../../../../../lib/server/http/route";
import { identityProvider } from "../../../../../lib/server/identity/registry";

// 판매자 비밀번호 찾기 시작(이메일+쇼핑몰). 계정 유무와 상관없이 같은 응답이고, PASS 인증 창을 열 requestId를 준다.
export const POST = mutation(async (req: Request) => {
  const body = await readJson<{ email: string; shopSlug: string }>(req);
  if (!isString(body.email) || !isString(body.shopSlug)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const r = await startSellerPasswordReset(prisma, identityProvider(), { email: body.email, shopSlug: body.shopSlug }, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: 429 });
  const res = NextResponse.json({ verificationId: r.verificationId, requestId: r.requestId }, { headers: { "cache-control": "no-store" } });
  setFlowCookie(res, IDV_COOKIE, r.ownerToken, RESET_PATH, 10 * 60);
  return res;
});
