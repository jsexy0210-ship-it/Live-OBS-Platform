import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta } from "../../../../../../lib/server/http/route";
import { BUYER_REVIEW_MESSAGES, deleteReview, myReview, updateReview } from "../../../../../../lib/server/product-reviews/service";

type Ctx = { params: Promise<{ slug: string; reviewId: string }> };
const status = (reason: string) =>
  reason === "shop_unavailable" ? 402 : reason === "already_written" || reason === "already_reported" || reason === "not_editable" ? 409 : reason === "not_writable" ? 403 : 400;

// 내 리뷰 한 건(고치기 화면): { review }. 본인·지우지 않은 리뷰만, 남의 리뷰·없는 리뷰는 404. 고칠 수 있는지(editable)는 서버가 정한다.
export async function GET(req: Request, { params }: Ctx) {
  try {
    const { slug, reviewId } = await params;
    const b = await buyerScope(req, slug);
    if (!b.scope) return noStore(b.res);
    const review = await myReview(prisma, b.scope, slug, reviewId);
    if (!review) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
    return noStore(NextResponse.json({ review }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

// 내 리뷰 고치기(쓴 뒤 7일 안, 숨긴 리뷰는 안 됨). 본문은 올리기와 같다. 남의 리뷰는 404.
export const PUT = mutation(async (req: Request, { params }: Ctx) => {
  const { slug, reviewId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await updateReview(prisma, b.scope, reviewId, await readJson(req), requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: BUYER_REVIEW_MESSAGES[r.reason] }, { status: status(r.reason) }));
  return noStore(NextResponse.json(r));
});

// 내 리뷰 지우기(언제든, 쇼핑몰 이용이 막히면 안 됨). 지급한 리뷰 적립금은 회수한다.
export const DELETE = mutation(async (req: Request, { params }: Ctx) => {
  const { slug, reviewId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await deleteReview(prisma, b.scope, reviewId, requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: BUYER_REVIEW_MESSAGES[r.reason] }, { status: status(r.reason) }));
  return noStore(NextResponse.json(r));
});
