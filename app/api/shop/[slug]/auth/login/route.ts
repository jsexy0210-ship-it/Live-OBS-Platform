import { NextResponse } from "next/server";
import { loginBuyer } from "../../../../../../lib/server/auth/login";
import { prisma } from "../../../../../../lib/server/db";
import { assertSameOrigin, errorResponse, isString, loginFailureStatus, readJson, requestMeta, setSessionCookie } from "../../../../../../lib/server/http/route";

// 구매자 로그인은 쇼핑몰 단위. 쇼핑몰 주소(slug)로 판매자를 정하고, 운영 중인 쇼핑몰만 받는다.
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    assertSameOrigin(req);
    const { slug } = await params;
    const seller = await prisma.seller.findUnique({ where: { slug }, select: { id: true, status: true } });
    if (!seller || seller.status !== "ACTIVE") return NextResponse.json({ error: "not_found" }, { status: 404 });
    const body = await readJson<{ loginId: string; password: string }>(req);
    if (!isString(body.loginId) || !isString(body.password)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const result = await loginBuyer(prisma, { sellerId: seller.id, loginId: body.loginId, password: body.password }, requestMeta(req));
    if (!result.ok) return NextResponse.json({ error: result.reason }, { status: loginFailureStatus(result.reason) });
    const res = NextResponse.json({ ok: true });
    setSessionCookie(res, "buyer", result.token, result.expiresAt);
    return res;
  } catch (e) {
    return errorResponse(e);
  }
}
