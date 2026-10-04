import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta } from "../../../../../../../lib/server/http/route";
import { BUYER_REVIEW_MESSAGES, createReview, writableItem } from "../../../../../../../lib/server/product-reviews/service";

type Ctx = { params: Promise<{ slug: string; orderItemId: string }> };
const status = (reason: string) =>
  reason === "shop_unavailable" ? 402 : reason === "already_written" || reason === "already_reported" || reason === "not_editable" ? 409 : reason === "not_writable" ? 403 : 400;

// 리뷰 쓰기 화면용: 이 주문 상품을 지금 쓸 수 있으면 { item }, 아니면 404(기간 지남·이미 씀·남의 주문).
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { slug, orderItemId } = await params;
    const b = await buyerScope(req, slug);
    if (!b.scope) return noStore(b.res);
    const item = await writableItem(prisma, b.scope, orderItemId);
    if (!item) return noStore(NextResponse.json({ error: "not_writable", message: BUYER_REVIEW_MESSAGES.not_writable }, { status: 404 }));
    return noStore(NextResponse.json({ item }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 리뷰 올리기. 본문 { rating: 1~5, body: 10~1000자, imageIds?: 올린 사진 id(5장까지) }. 응답 { reviewId, status, grantedReward }.
export const POST = mutation(async (req: Request, { params }: Ctx) => {
  const { slug, orderItemId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await createReview(prisma, b.scope, orderItemId, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: BUYER_REVIEW_MESSAGES[r.reason] }, { status: status(r.reason) }));
  return noStore(NextResponse.json(r, { status: 201 }));
});
