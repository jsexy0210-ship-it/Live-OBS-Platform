import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { shopShareMeta } from "../../../../../lib/server/shop/sharePreview";

// 쇼핑몰 페이지의 공유 미리보기 값(og:title·og:description·og:image, 파비콘). 로그인 없이 읽는다.
// ?productId=: 상품 상세면 판매 중·품절 상품 이름이 제목으로 우선한다. 운영 중이 아니거나 잠긴 쇼핑몰은 404.
// favicon이 null이면 ONQ 기본 아이콘을 쓴다(쇼핑몰 파비콘 업로드는 이미지 저장소 결정 뒤).
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const meta = await shopShareMeta(prisma, slug, new URL(req.url).searchParams.get("productId"));
  if (!meta) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(meta, { headers: { "cache-control": "public, max-age=60" } });
}
