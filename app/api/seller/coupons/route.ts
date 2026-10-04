import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { COUPON_MESSAGES } from "../../../../lib/server/shop-coupons/rules";
import { createCoupon, listCoupons } from "../../../../lib/server/shop-coupons/service";

// 쿠폰 목록·집계(SA-035)와 만들기. 조회는 같은 쇼핑몰 파트너스 계정 누구나, 만들기는 대표자·적립금(MEMBER_POINTS) 직원만(그 밖 403).
// 플랜 기능 STORE_OPERATIONS. POST 본문은 lib/server/shop-coupons/rules.ts parseCoupon. 검사에 걸리면 400·409 { error, message }.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json(await listCoupons(prisma, ctx)));
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await createCoupon(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: COUPON_MESSAGES[r.reason] }, { status: r.reason === "code_taken" || r.reason === "too_many" ? 409 : 400 });
  return NextResponse.json({ coupon: r.coupon }, { status: 201 });
});
