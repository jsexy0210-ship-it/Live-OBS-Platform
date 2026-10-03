import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, queueRejectionStatus, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { refundOrder } from "../../../../../../lib/server/queue/service";

// 화면에 바로 보여 줄 안내 문구가 있는 환불 거부 사유
type RefundMessageCode = "fault_required" | "opened_items_present" | "opened_items_unshipped";
const REFUND_MESSAGE_CODES = new Set<string>(["fault_required", "opened_items_present", "opened_items_unshipped"] satisfies RefundMessageCode[]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 결제 완료 주문 환불(개봉 전 품목만 재고 복구, 연결된 대기·개봉 중 자동 취소). 사유·expectedVersion 필수, ORDER_SHIPPING 권한.
// 개봉을 시작했거나 마친 품목이 있으면 confirmOpened: true가 있어야 한다(없으면 409 opened_items_present).
// fault: "BUYER"(구매자 사정) | "SELLER"(판매자 사정). 발송했거나 개봉한 품목이 있으면 꼭 보낸다(없으면 400 fault_required).
// expectedRefundAmount: 화면에서 확인받은 환불액(필수, 0 이상 정수. 없으면 400). 서버가 계산한 금액과 다르면 409 refund_amount_changed로
// 아무것도 바꾸지 않는다(되돌릴 수 없는 환불이라 확인한 금액으로만 실행, MASTER 결정 2026-10-03).
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ orderId: string }> }) => {
  // 잠금 중에도 이미 받은 주문은 처리할 수 있다(대표님 결정 2026-10-02, PRODUCT_SCOPE 「잠금 중 허용 범위」).
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true });
  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ reason: string; expectedVersion: number; confirmOpened: boolean; fault: unknown; expectedRefundAmount: unknown }>(req);
  if (!Number.isInteger(body.expectedVersion)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  if (body.fault != null && body.fault !== "BUYER" && body.fault !== "SELLER") return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const amount = body.expectedRefundAmount;
  if (!(Number.isSafeInteger(amount) && (amount as number) >= 0)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const result = await refundOrder(prisma, ctx, orderId, {
    reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : undefined,
    expectedLiveVersion: body.expectedVersion as number,
    confirmOpened: body.confirmOpened === true,
    fault: body.fault ?? undefined,
    expectedRefundAmount: amount as number,
  });
  if (!result.ok) {
    const status = queueRejectionStatus(result.reason);
    return NextResponse.json(REFUND_MESSAGE_CODES.has(result.reason) ? orderErrorBody(result.reason as RefundMessageCode) : { error: result.reason }, { status });
  }
  return NextResponse.json({ ...result.value, version: result.version });
});
