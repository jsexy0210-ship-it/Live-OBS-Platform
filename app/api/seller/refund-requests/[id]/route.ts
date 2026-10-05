import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { getSellerRefundRequest } from "../../../../../lib/server/payments/refundRequest";

// 환불 요청 상세: 요청 + 주문 요약 + (진행 중이면) 요청한 품목의 환불 미리보기(refundPreview, 환불 미리보기와 같은 모양)·승인 때 보낼 queueVersion.
// 미리보기를 못 만들면 previewError(invalid_refund_items·queued_item_partial 등). 다른 파트너스 요청은 404.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const r = await getSellerRefundRequest(prisma, ctx, (await params).id);
    return noStore(r ? NextResponse.json(r) : NextResponse.json({ error: "not_found" }, { status: 404 }));
  } catch (e) {
    return errorResponse(e);
  }
}
