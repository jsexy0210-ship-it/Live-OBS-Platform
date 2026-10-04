import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, sessionToken } from "../../../../../../lib/server/http/route";
import { reconfirmPurchase } from "../../../../../../lib/server/orders/delivery";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 구매 확정 다시 하기(확정을 취소했지만 환불하지 않는 결제 완료 주문만). ORDER_SHIPPING 권한.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ orderId: string }> }) => {
  // 잠금 중에도 이미 받은 주문은 처리할 수 있다(PRODUCT_SCOPE 「잠금 중 허용 범위」).
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await reconfirmPurchase(prisma, ctx, orderId);
  if (!r.ok) {
    if (r.reason === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 409 });
  }
  return NextResponse.json({ purchaseConfirmedAt: r.purchaseConfirmedAt });
});
