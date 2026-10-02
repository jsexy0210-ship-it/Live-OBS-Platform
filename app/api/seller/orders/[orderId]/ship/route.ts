import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { shipOrder } from "../../../../../../lib/server/orders/ship";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 즉시 발송 처리. 본문: { courier: "CJ" 등 코드, trackingNumber }. ORDER_SHIPPING 권한.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ orderId: string }> }) => {
  // 잠금 중에도 이미 받은 주문은 처리할 수 있다(대표님 결정 2026-10-02, PRODUCT_SCOPE 「잠금 중 허용 범위」).
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true });
  const { orderId } = await params;
  if (!UUID.test(orderId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = await readJson<{ courier: unknown; trackingNumber: unknown }>(req);
  const r = await shipOrder(prisma, ctx, orderId, { courier: body.courier, trackingNumber: body.trackingNumber });
  if (!r.ok) {
    if (r.reason === "not_found") return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(orderErrorBody(r.reason), { status: r.reason === "not_shippable" ? 409 : 400 });
  }
  return NextResponse.json(r.shipment);
});
