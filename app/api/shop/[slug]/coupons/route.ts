import { NextResponse } from "next/server";
import { buyerScope } from "../../../../../lib/server/buyers/scope";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore } from "../../../../../lib/server/http/route";
import { buyerCouponBox } from "../../../../../lib/server/shop-coupons/service";

// 내 쿠폰함(SH-028): { usable, claimable, past }. 받은 쿠폰 조회는 잠긴 쇼핑몰이어도 열고, 받을 수 있는 쿠폰은 운영 중일 때만 보인다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  try {
    const b = await buyerScope(req, (await params).slug);
    if (!b.scope) return noStore(b.res);
    const box = await buyerCouponBox(prisma, b.scope);
    const open = await shopOpen(prisma, b.scope.sellerId);
    return noStore(NextResponse.json({ ...box, claimable: open ? box.claimable : [], shopOpen: open }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
