import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../../lib/server/http/route";
import { CODE_MESSAGES, redeemCouponCode } from "../../../../../../lib/server/shop-coupons/service";

// 쿠폰 코드 등록. 본문 { code }(대소문자 구분 없음). 10분에 10번 넘게 틀리면 429. 운영 중이 아닌 쇼핑몰은 402.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const body = await readJson<{ code?: unknown }>(req);
  const r = await redeemCouponCode(prisma, b.scope, body.code, requestMeta(req));
  if (!r.ok) {
    const status = r.reason === "shop_unavailable" ? 402 : r.reason === "code_attempts" ? 429 : r.reason === "coupon_not_found" ? 404 : 409;
    return noStore(NextResponse.json({ error: r.reason, message: CODE_MESSAGES[r.reason] }, { status }));
  }
  return noStore(NextResponse.json({ coupon: r.coupon }, { status: 201 }));
});
