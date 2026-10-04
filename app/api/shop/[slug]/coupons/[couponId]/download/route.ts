import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, requestMeta } from "../../../../../../../lib/server/http/route";
import { BUYER_COUPON_MESSAGES, downloadCoupon } from "../../../../../../../lib/server/shop-coupons/service";

// 쿠폰 받기(내려받기 방식). 운영 중이 아니거나 스토어 운영 권한이 없는 쇼핑몰은 402.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string; couponId: string }> }) => {
  const { slug, couponId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  const r = await downloadCoupon(prisma, b.scope, couponId, requestMeta(req));
  if (!r.ok) {
    const status = r.reason === "shop_unavailable" ? 402 : r.reason === "coupon_not_found" ? 404 : 409;
    return noStore(NextResponse.json({ error: r.reason, message: BUYER_COUPON_MESSAGES[r.reason] }, { status }));
  }
  return noStore(NextResponse.json({ coupon: r.coupon }, { status: 201 }));
});
