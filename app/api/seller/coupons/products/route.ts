import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { searchCouponProducts } from "../../../../../lib/server/shop-coupons/service";

// 쿠폰 적용 상품 고르기: ?q=상품 이름(50자까지) → { products: [{ id, name }] }(20개). 파트너스 계정 누구나 조회.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json({ products: await searchCouponProducts(prisma, ctx, new URL(req.url).searchParams.get("q")) }));
  } catch (e) {
    return errorResponse(e);
  }
}
