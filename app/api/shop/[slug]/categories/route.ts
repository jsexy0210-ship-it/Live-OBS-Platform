import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { publicCategories } from "../../../../../lib/server/shop-category/service";

// 구매자 쇼핑몰 카테고리 메뉴. 로그인 없이 읽는다. 보이는 대분류와 그 아래 보이는 소분류만, 순서대로.
// 응답 { categories: [{ id, name, children: [{ id, name }] }] }. 운영 중이 아니거나 잠긴·스토어 운영 권한이 없는 쇼핑몰은 404.
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const categories = await publicCategories(prisma, slug);
  if (!categories) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ categories }, { headers: { "cache-control": "public, max-age=30" } });
}
