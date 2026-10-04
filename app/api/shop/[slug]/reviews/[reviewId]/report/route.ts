import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../../../lib/server/http/route";
import { BUYER_REVIEW_MESSAGES, reportReview } from "../../../../../../../lib/server/product-reviews/service";

const status = (reason: string) =>
  reason === "shop_unavailable" ? 402 : reason === "already_written" || reason === "already_reported" || reason === "not_editable" ? 409 : reason === "not_writable" ? 403 : 400;

// 공개 리뷰 신고(1인 1번, 내 리뷰 제외). 본문 { reason: PRIVACY|OFF_TOPIC|ABUSE|AD|OTHER }. 3건이 쌓이면 보류된다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string; reviewId: string }> }) => {
  const { slug, reviewId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const body = await readJson<{ reason?: unknown }>(req);
  const r = await reportReview(prisma, b.scope, reviewId, body.reason, requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: BUYER_REVIEW_MESSAGES[r.reason] }, { status: status(r.reason) }));
  return noStore(NextResponse.json(r, { status: 201 }));
});
