import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { getSellerReceiptRequest } from "../../../../../lib/server/receipts/manual";

// 신청 상세(SA-024 처리 창·보기): 직접 발행에 필요한 번호 전체(identity)·사업자 정보·주문 요약. 번호를 연 사실은 로그 추적(receipt_request.reveal_identity)에 남는다. RECEIPT_TAX 권한.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const r = await getSellerReceiptRequest(prisma, ctx, (await params).id);
    if (!r) return noStore(NextResponse.json({ error: "not_found", message: "신청을 찾을 수 없습니다" }, { status: 404 }));
    return noStore(NextResponse.json({ request: r }));
  } catch (e) {
    return errorResponse(e);
  }
}
