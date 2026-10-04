import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { replyReview, SELLER_REVIEW_MESSAGES } from "../../../../../../lib/server/product-reviews/service";

// 리뷰 답글 쓰기·고치기·지우기. 본문 { reply: string(300자) | null }. 대표자·구매자 문의(INQUIRY_REPLY) 직원만.
export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ reviewId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await replyReview(prisma, ctx, (await params).reviewId, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: SELLER_REVIEW_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json(r);
});
