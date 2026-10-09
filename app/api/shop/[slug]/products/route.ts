import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";
import { clientIp } from "../../../../../lib/server/http/route";
import { shopProductList } from "../../../../../lib/server/products/shopCatalog";

// 구매자 쇼핑몰 상품 목록(로그인 없음). ?categoryId(대분류는 하위 포함, 여러 개는 쉼표나 반복으로 주면 모두에 속한 상품만, 최대 5개)·q(검색어 50자, 상품 이름·검색 태그·판매자 유사어로 찾고 결과가 있으면 인기 검색어로 셈)·sort(new|recommended|popular|low|high|relevance: q가 있을 때만 관련도순)·inStock(1: 재고 있는 상품만)·live(1: 방송 중 상품만)·rating4(1: 공개 리뷰 평균 4.0 이상)·coupon(1: 판매자의 발급 중 쿠폰 상품 범위)·minPrice·maxPrice(표시 가격 원, 정수)·page·limit(1~60, 기본 24)
// 응답 { products: [{ id, code, name, price, salePrice, soldOut, thumbnailUrl, rating, reviewCount, reward }], total, page, hasMore }(rating·reviewCount는 공개 리뷰 기준, reward는 기본 등급 적립 예정).
// 운영 중이 아닌 쇼핑몰·보이지 않는 카테고리는 404, 틀린 값은 400.
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const r = await shopProductList(prisma, slug, { ...Object.fromEntries(["q", "sort", "page", "limit", "inStock", "live", "rating4", "coupon", "minPrice", "maxPrice"].map((k) => [k, sp.get(k) ?? undefined])), categoryId: sp.getAll("categoryId").length ? sp.getAll("categoryId").join(",") : undefined }, undefined, clientIp(req));
  if (!r.ok) return r.reason === "not_found" ? NextResponse.json({ error: "not_found" }, { status: 404 }) : NextResponse.json(orderErrorBody(r.reason), { status: 400 });
  // 가격·품절은 곧 바뀔 수 있어 짧게만 캐시한다
  return NextResponse.json(r.value, { headers: { "cache-control": "public, max-age=30" } });
}
