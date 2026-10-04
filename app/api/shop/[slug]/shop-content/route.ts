import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { visibleShopContent } from "../../../../../lib/server/shop-content/service";

// 구매자 화면의 홈 배너·이벤트 팝업. 로그인 없이 읽는다. ?page=home(홈: 배너 + HOME·ALL 팝업) | other(그 밖 화면: ALL 팝업만).
// 기간은 DB 시계로 판단한다. 운영 중이 아니거나 잠긴·스토어 운영 권한이 없는 쇼핑몰은 404.
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const page = new URL(req.url).searchParams.get("page") === "home" ? "home" : "other";
  const content = await visibleShopContent(prisma, slug, page);
  if (!content) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // 기간이 끝나면 곧 사라져야 하므로 짧게만 캐시한다
  return NextResponse.json(content, { headers: { "cache-control": "public, max-age=30" } });
}
