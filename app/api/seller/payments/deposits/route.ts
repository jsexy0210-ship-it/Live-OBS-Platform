import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { listPendingDeposits } from "../../../../../lib/server/payments/bank";
import { sellerPaymentErrorBody } from "../../../../../lib/server/payments/messages";

// 입금 대기 목록(SA-026, ORDER_SHIPPING 조회). ?offset·limit(기본 20·최대 50). 응답 { deposits: [{ orderId, orderNo, amount, nickname,
// depositorName?(CUSTOMER_PII_VIEW 있을 때만), paymentMethod, paymentDueAt, createdAt }], total }. 입금 기한 빠른 순. 잠긴 쇼핑몰도 이미 받은 주문은 처리한다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const q = new URL(req.url).searchParams;
    const r = await listPendingDeposits(prisma, ctx, { offset: q.get("offset") ?? undefined, limit: q.get("limit") ?? undefined });
    if (!r.ok) return noStore(NextResponse.json(sellerPaymentErrorBody("invalid_request"), { status: 400 }));
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
