import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../lib/server/http/route";
import { listSellerReceiptRequests, receiptFilterValid } from "../../../../lib/server/receipts/service";

// 현금영수증·세금계산서 신청 목록(SA-024). ?status(PENDING·ON_HOLD·ISSUED·FAILED·CANCELLED)·kind(CASH_RECEIPT·TAX_INVOICE·세부 종류)·from·to(KST 날짜, 접수 기간)·field(nickname·bizno·phone)·q·cursor.
// 상태별 건수 counts, 상단 요약 summary(대기·실패·취소·이번 달 발행 완료 건수·금액). 날짜·검색 값이 잘못되면 400 invalid_filter. 영수증·세금계산서 권한(RECEIPT_TAX).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const q = new URL(req.url).searchParams;
    const filter = { status: q.get("status"), kind: q.get("kind"), from: q.get("from"), to: q.get("to"), field: q.get("field"), q: q.get("q"), cursor: q.get("cursor") };
    if (!receiptFilterValid(filter)) return noStore(NextResponse.json({ error: "invalid_filter", message: "기간 또는 검색어를 확인해 주십시오" }, { status: 400 }));
    return noStore(NextResponse.json(await listSellerReceiptRequests(prisma, ctx, filter)));
  } catch (e) {
    return errorResponse(e);
  }
}
