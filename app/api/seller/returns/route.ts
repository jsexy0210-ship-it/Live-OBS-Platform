import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listSellerReturns } from "../../../../lib/server/shop-returns/service";

// 교환·반품 목록(SA-029). ?status(REQUESTED·ACCEPTED·RECEIVED·COMPLETED·REJECTED·CANCELLED)·kind(RETURN·EXCHANGE)·cursor. 조회는 주문·배송 권한(ORDER_SHIPPING).
export async function GET(req: Request) {
  try {
    // 잠금 중에도 이미 받은 주문의 처리는 연다(PRODUCT_SCOPE 「잠금 중 허용 범위」, 환불과 같음)
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const q = new URL(req.url).searchParams;
    return noStore(NextResponse.json(await listSellerReturns(prisma, ctx, { status: q.get("status"), kind: q.get("kind"), cursor: q.get("cursor") })));
  } catch (e) {
    return errorResponse(e);
  }
}
