import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../../lib/server/http/route";
import { myReviews } from "../../../../../lib/server/product-reviews/service";

// 내 리뷰(SH-029): { writable(쓸 수 있는 주문 상품)·writableNextCursor, reviews(내가 쓴 리뷰·숨김 사유·답글)·nextCursor, reward, writableDays }.
// 다음 쪽은 ?cursor= / ?writableCursor=로 읽는다(50개씩). 잠긴 쇼핑몰이어도 읽기는 연다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const { slug } = await params;
    const b = await buyerScope(req, slug);
    if (!b.scope) return noStore(b.res);
    const u = new URL(req.url).searchParams;
    return noStore(NextResponse.json(await myReviews(prisma, b.scope, slug, { cursor: u.get("cursor"), writableCursor: u.get("writableCursor") })));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
