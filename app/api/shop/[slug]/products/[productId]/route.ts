import { NextResponse } from "next/server";
import { resolveBuyerSession } from "../../../../../../lib/server/auth/session";
import { prisma } from "../../../../../../lib/server/db";
import { sessionToken } from "../../../../../../lib/server/http/route";
import { shopProductDetail } from "../../../../../../lib/server/products/shopCatalog";

// 구매자 상품 상세(로그인 없이 읽음). 사진·옵션(가격·할인가·품절·적을 때 남은 수)·상세 블록·카테고리·배송비 정책·적립 예정(로그인 회원은 그 등급,
// 아니면 기본 등급 적립률로 표시 가격 기준). 운영 중이 아닌 쇼핑몰·보이지 않는 상품(판매 대기·숨김·삭제)은 404.
// 로그인 회원마다 적립 예정이 달라 캐시하지 않는다.
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; productId: string }> }) {
  const { slug, productId } = await ctx.params;
  const shop = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  const session = shop ? await resolveBuyerSession(prisma, sessionToken(req, "buyer"), shop.id) : null;
  const product = await shopProductDetail(prisma, slug, productId, session?.member.gradeId);
  if (!product) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "no-store" } });
  return NextResponse.json({ product }, { headers: { "cache-control": "private, no-store" } });
}
