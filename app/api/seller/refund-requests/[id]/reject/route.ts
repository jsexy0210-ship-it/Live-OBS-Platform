import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { refundRequestError, rejectRefundRequest } from "../../../../../../lib/server/payments/refundRequest";

// 환불 요청 거절(ORDER_SHIPPING), 요청 단계만. body { reason }: 구매자에게 보이는 사유(1~200자, 없으면 400 invalid_reject_reason). 로그 추적 refund_request.reject.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const r = await rejectRefundRequest(prisma, ctx, (await params).id, await readJson<Record<string, unknown>>(req));
  if (!r.ok) {
    const e = refundRequestError(r.reason, "seller");
    return NextResponse.json(e.body, { status: e.status });
  }
  return noStore(NextResponse.json({ request: r.request }));
});
