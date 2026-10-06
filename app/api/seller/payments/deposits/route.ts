import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { listPendingDeposits } from "../../../../../lib/server/payments/bank";
import { sellerPaymentErrorBody } from "../../../../../lib/server/payments/messages";

// SA-026 읽기 계약: from/to=KST 주문일(YYYY-MM-DD), status=ALL 또는 쉼표로 연결한
// PENDING_PAYMENT/OVERDUE/PAID/AUTO_CANCELLED, q/searchBy=buyer|depositor|amount.
// 상태 생략은 기존 입금 대기 목록. summary는 필터와 독립된 판매자 전체 현황이다.
// 실제 입금자명은 미수집. legacy depositorName은 구매자 실명이며 depositor 검색은 미지원이다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const q = new URL(req.url).searchParams;
    const r = await listPendingDeposits(prisma, ctx, {
      offset: q.get("offset") ?? undefined, limit: q.get("limit") ?? undefined,
      from: q.get("from") ?? undefined, to: q.get("to") ?? undefined,
      status: q.get("status") ?? undefined, q: q.get("q") ?? undefined, searchBy: q.get("searchBy") ?? undefined,
    });
    if (!r.ok) return noStore(NextResponse.json("reason" in r ? {
      error: r.reason, message: "실제 입금자명은 수집되지 않아 검색할 수 없습니다.",
    } : sellerPaymentErrorBody("invalid_request"), { status: 400 }));
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
