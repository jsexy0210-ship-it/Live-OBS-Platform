import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, queueRejectionStatus, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { returnError } from "../../../../../../lib/server/shop-returns/http";
import { refundReturn } from "../../../../../../lib/server/shop-returns/service";

const REFUND_MESSAGE_CODES = new Set<string>(["fault_required", "opened_items_present", "opened_items_unshipped", "purchase_confirmed"]);

// 반품 환불(ORDER_SHIPPING), 반품의 회수 완료 단계만. 기존 환불(POST /api/seller/orders/{id}/refund)을 호출한다(실제 PG 취소는 결제 연결이 맡음).
// body { expectedVersion, expectedRefundAmount, confirmOpened? }: 상세가 준 queueVersion과 화면에서 확인받은 환불액. 금액이 다르면 409 refund_amount_changed.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const { id } = await params;
  const body = await readJson<{ expectedVersion: unknown; expectedRefundAmount: unknown; confirmOpened: unknown }>(req);
  const amount = body.expectedRefundAmount;
  if (!Number.isInteger(body.expectedVersion) || !(Number.isSafeInteger(amount) && (amount as number) >= 0)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const r = await refundReturn(prisma, ctx, id, { expectedVersion: body.expectedVersion as number, expectedRefundAmount: amount as number, confirmOpened: body.confirmOpened === true });
  if (!r.ok) {
    if ("refund" in r) return NextResponse.json(REFUND_MESSAGE_CODES.has(r.reason) ? orderErrorBody(r.reason as "fault_required", "formal") : { error: r.reason }, { status: queueRejectionStatus(r.reason) });
    return returnError(r.reason, "seller");
  }
  return noStore(NextResponse.json({ request: r.request, refund: r.refund, version: r.version }));
});
