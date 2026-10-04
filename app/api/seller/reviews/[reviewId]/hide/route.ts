import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { hideReview, SELLER_REVIEW_MESSAGES } from "../../../../../../lib/server/product-reviews/service";

// 리뷰 숨기기. 본문 { reason: PRIVACY|OFF_TOPIC|ABUSE|AD|OTHER, note?: string(200자) }. 지급한 리뷰 적립금은 회수. INQUIRY_REPLY.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ reviewId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await hideReview(prisma, ctx, (await params).reviewId, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: SELLER_REVIEW_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json(r);
});
