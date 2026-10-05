import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/server/db";
import { searchSuggestions } from "../../../../../../lib/server/shop-search/service";

// 검색어 자동완성(로그인 없이). ?q(1~20자). 응답 { suggestions: [{ text, kind: term(인기 검색어) | product(상품 이름) | tag(상품 태그) }] } 최대 8개.
// 유사어 묶음의 단어로도 찾는다. 비어 있거나 20자를 넘는 q는 빈 목록. 운영 중이 아닌 쇼핑몰은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const r = await searchSuggestions(prisma, (await params).slug, new URL(req.url).searchParams.get("q") ?? "");
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(r, { headers: { "cache-control": "public, max-age=30" } });
}
