import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { publishReview } from "../../../../../../lib/server/product-reviews/service";

// 리뷰 공개(공개 대기·보류·숨김 → 공개). 리뷰 적립금 지급(설정 금액, 이미 지급됐으면 그대로). INQUIRY_REPLY.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ reviewId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await publishReview(prisma, ctx, (await params).reviewId, requestMeta(req));
  return NextResponse.json(r);
});
