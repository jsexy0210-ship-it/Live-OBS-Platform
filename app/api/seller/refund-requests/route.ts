import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listSellerRefundRequests } from "../../../../lib/server/payments/refundRequest";

// 구매자 환불 요청 목록(SA-023). ?status(REQUESTED·APPROVED·REJECTED·CANCELLED)·?sort(oldest·newest, 처리 대기는 기본 오래된 순)·cursor. 상태별 건수 counts. 주문·배송 권한(ORDER_SHIPPING).
export async function GET(req: Request) {
  try {
    // 잠금 중에도 이미 받은 주문의 처리는 연다(환불과 같음)
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const q = new URL(req.url).searchParams;
    return noStore(NextResponse.json(await listSellerRefundRequests(prisma, ctx, { status: q.get("status"), sort: q.get("sort"), cursor: q.get("cursor") })));
  } catch (e) {
    return errorResponse(e);
  }
}
