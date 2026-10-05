import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../../lib/server/orders/messages";
import { parseRefundSelection } from "../../../../../../../lib/server/payments/refundSelection";
import { previewRefundSelection } from "../../../../../../../lib/server/queue/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 부분 환불 미리보기(계산만, 상태 변경 없음, SA-023). 본문 { items?: [{ orderItemId, quantity }] }(없으면 남은 품목 전부).
// 응답은 주문 상세의 refundPreview와 같은 모양(사유 주체별 금액·품목별 남은 수량·isFinal·회수할 적립). 결제 완료 주문이 아니면 404.
// 잘못 고르면 400 invalid_refund_items, 개봉 대기·개봉 중 품목의 수량 일부는 409 queued_item_partial(환불 API와 같음).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ orderId: string }> }) => {
  // 잠금 중에도 이미 받은 주문은 처리할 수 있다(환불과 같은 가드)
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ items: unknown }>(req);
  const items = parseRefundSelection(body.items);
  if (items === null) return NextResponse.json(orderErrorBody("invalid_refund_items", "formal"), { status: 400 });
  const r = await previewRefundSelection(prisma, ctx, orderId, items);
  if (!r.ok) {
    if (r.reason === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: r.reason === "invalid_refund_items" ? 400 : 409 });
  }
  return NextResponse.json(r.value, { headers: { "cache-control": "no-store" } });
});
