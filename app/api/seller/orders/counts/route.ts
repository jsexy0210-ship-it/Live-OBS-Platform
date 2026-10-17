import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { countSellerOrders } from "../../../../../lib/server/orders/bulk";

// 주문 목록 칩 건수(SA-021, ORDER_SHIPPING): { counts: { total, today, todaySales, unpaid, trackingMissing, queueWaiting, queueOpening, queueDone, queueDonePending(개봉 완료 중 배송 준비로 바꾸지 않은 주문, 목록 ?queue=done&prepared=false), refundRequested, cancelled, refunded } }.
// 건수는 목록 필터(?trackingMissing=true · ?queue=waiting|opening|done · ?refundRequested=true · ?status=PENDING_PAYMENT|CANCELLED|REFUNDED)와 같은 조건으로 센다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    return noStore(NextResponse.json({ counts: await countSellerOrders(prisma, ctx) }));
  } catch (e) {
    return errorResponse(e);
  }
}
