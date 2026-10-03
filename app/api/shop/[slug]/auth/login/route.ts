import { NextResponse } from "next/server";
import { isEmailLengthOk, loginBuyer } from "../../../../../../lib/server/auth/login";
import { loginErrorBody, SHOP_NOT_FOUND_MESSAGE } from "../../../../../../lib/server/auth/messages";
import { prisma } from "../../../../../../lib/server/db";
import { isString, loginFailureStatus, mutation, readJson, requestMeta, setSessionCookie } from "../../../../../../lib/server/http/route";

// 구매자 로그인은 쇼핑몰 단위. 쇼핑몰 주소(slug)로 판매자를 정하고, 운영 중인 쇼핑몰만 받는다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const { slug } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug }, select: { id: true, status: true } });
  if (!seller || seller.status !== "ACTIVE") return NextResponse.json({ error: "not_found", message: SHOP_NOT_FOUND_MESSAGE }, { status: 404 });
  const body = await readJson<{ loginId: string; password: string }>(req);
  // 아이디(이메일)는 가입과 같은 기준(앞뒤 공백을 지우고 254자까지)으로 받는다
  if (!isEmailLengthOk(body.loginId) || !isString(body.password)) return NextResponse.json(loginErrorBody("bad_request", "buyer"), { status: 400 });
  const result = await loginBuyer(prisma, { sellerId: seller.id, loginId: body.loginId, password: body.password }, requestMeta(req));
  // 실패는 { error, message(화면 문구) }. 아이디·비밀번호 중 무엇이 틀렸는지는 구분하지 않는다.
  if (!result.ok) return NextResponse.json(loginErrorBody(result.reason, "buyer"), { status: loginFailureStatus(result.reason) });
  const res = NextResponse.json({ ok: true });
  setSessionCookie(res, "buyer", result.token, result.expiresAt);
  return res;
});
