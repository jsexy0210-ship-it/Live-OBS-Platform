import { NextResponse } from "next/server";
import { prisma } from "../../../../../../../lib/server/db";
import { orderErrorBody } from "../../../../../../../lib/server/orders/messages";
import { shopRecommendations } from "../../../../../../../lib/server/products/shopCatalog";

// 상품 상세의 추천 상품(로그인 없이, AI 없음). ?limit(1~20, 기본 8). 응답 { products: [상품 카드 + reason(pick|category|best|new)] }.
// 순서: 운영자 지정 → 같은 카테고리 판매량(30일) → 같은 카테고리 최신 → 전체 판매량 → 전체 최신. 자기 자신은 빠지고 품절은 뒤로(품절 숨기기를 켠 쇼핑몰은 뺌).
// 운영 중이 아닌 쇼핑몰·보이지 않는 상품은 404, 틀린 limit은 400.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; productId: string }> }) {
  const { slug, productId } = await params;
  const r = await shopRecommendations(prisma, slug, productId, new URL(req.url).searchParams.get("limit") ?? undefined);
  if (!r.ok) return r.reason === "not_found" ? NextResponse.json({ error: "not_found" }, { status: 404 }) : NextResponse.json(orderErrorBody(r.reason), { status: 400 });
  return NextResponse.json(r.value, { headers: { "cache-control": "public, max-age=30" } });
}
