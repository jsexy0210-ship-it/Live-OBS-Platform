import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, queueRejectionStatus, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { approveRefundRequest, refundRequestError } from "../../../../../../lib/server/payments/refundRequest";
import { kickPaymentCancels } from "../../../../../../lib/server/payments/worker";

const REFUND_MESSAGE_CODES = new Set<string>(["fault_required", "opened_items_present", "opened_items_unshipped", "purchase_confirmed", "invalid_refund_items", "queued_item_partial"]);

// 환불 요청 승인(ORDER_SHIPPING) = 요청한 품목으로 환불(POST /api/seller/orders/{id}/refund와 같은 규칙·거부 사유).
// body { expectedVersion, expectedRefundAmount, fault?: "BUYER"|"SELLER", confirmOpened? }: 상세가 준 queueVersion과 refundPreview.byFault[fault].refundAmount.
// 요청이 이미 처리됐으면 409 invalid_transition. 카드 결제면 커밋 뒤 테스트 PG 취소를 보낸다.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const body = await readJson<{ expectedVersion: unknown; expectedRefundAmount: unknown; fault: unknown; confirmOpened: unknown }>(req);
  const amount = body.expectedRefundAmount;
  if (!Number.isInteger(body.expectedVersion) || !(Number.isSafeInteger(amount) && (amount as number) >= 0)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (body.fault != null && body.fault !== "BUYER" && body.fault !== "SELLER") return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const r = await approveRefundRequest(prisma, ctx, (await params).id, {
    expectedVersion: body.expectedVersion as number,
    expectedRefundAmount: amount as number,
    fault: (body.fault as "BUYER" | "SELLER" | null) ?? undefined,
    confirmOpened: body.confirmOpened === true,
  });
  if (!r.ok) {
    if ("refund" in r) {
      if (r.reason === "invalid_transition") {
        const e = refundRequestError("invalid_transition", "seller");
        return NextResponse.json(e.body, { status: e.status });
      }
      return NextResponse.json(REFUND_MESSAGE_CODES.has(r.reason) ? orderErrorBody(r.reason as "fault_required", "formal") : { error: r.reason }, { status: queueRejectionStatus(r.reason) });
    }
    const e = refundRequestError(r.reason, "seller");
    return NextResponse.json(e.body, { status: e.status });
  }
  await kickPaymentCancels(prisma, r.refund.orderId);
  return noStore(NextResponse.json({ request: r.request, refund: r.refund, version: r.version }));
});
