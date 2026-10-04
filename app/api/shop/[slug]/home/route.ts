import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { publicHome } from "../../../../../lib/server/shop-display/service";

// 구매자 쇼핑몰 홈 진열(로그인 없음). 응답 { sections: [{ kind, title, categoryId, products: [상품 카드] }], listSort }.
// 켜진 영역만, 상품이 없는 영역은 뺀다. 운영 중이 아닌 쇼핑몰은 404.
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const home = await publicHome(prisma, slug);
  if (!home) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(home, { headers: { "cache-control": "public, max-age=30" } });
}
