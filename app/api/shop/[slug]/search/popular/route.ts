import { NextResponse } from "next/server";
import { prisma } from "../../../../../../lib/server/db";
import { popularSearchTerms } from "../../../../../../lib/server/shop-search/service";

// 인기 검색어(로그인 없이): { terms: string[] } 최근 7일(KST, 오늘 포함) 상위 10개. 자체 집계라 무료이고, 검색 결과가 있었던 말만 센다.
// 운영 중이 아니거나 스토어 운영 권한이 없는 쇼핑몰은 404.
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const r = await popularSearchTerms(prisma, (await params).slug);
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(r, { headers: { "cache-control": "public, max-age=60" } });
}
