import { NextResponse } from "next/server";
import { resolveBuyerSession } from "../auth/session";
import { prisma } from "../db";
import { sessionToken } from "../http/route";

// 구매자 본인 API 공통: 쇼핑몰(slug)과 구매자 세션을 확인한다. 실패하면 res(404·401)를 돌려준다.
export async function buyerScope(req: Request, slug: string) {
  const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!seller) return { res: NextResponse.json({ error: "not_found" }, { status: 404 }) };
  const session = await resolveBuyerSession(prisma, sessionToken(req, "buyer"), seller.id);
  if (!session) return { res: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  // sessionId는 scope 밖에 둔다(scope는 Prisma where에 그대로 펼쳐 쓰는 곳이 많아 모르는 키를 넣으면 안 된다). 지금 세션만 남겨야 하는 비밀번호 변경이 쓴다.
  return { scope: { sellerId: seller.id, buyerMemberId: session.member.id }, sessionId: session.sessionId };
}
