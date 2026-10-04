import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { getReviewPolicy, SELLER_REVIEW_MESSAGES, updateReviewPolicy } from "../../../../../lib/server/product-reviews/service";

// 리뷰 설정: 공개 방식·리뷰 적립금(글·사진, 기본 0원)·작성 가능 기간·금지어. 조회는 누구나, 바꾸기는 INQUIRY_REPLY.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await getReviewPolicy(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateReviewPolicy(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: SELLER_REVIEW_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ policy: r.policy });
});
