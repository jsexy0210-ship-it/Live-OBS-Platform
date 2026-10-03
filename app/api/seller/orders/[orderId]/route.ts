import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { getOrder } from "../../../../../lib/server/orders/read";
import { getRefundVersion } from "../../../../../lib/server/queue/read";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await params;
    // 잠금 중에도 이미 받은 주문은 처리할 수 있다(대표님 결정 2026-10-02, PRODUCT_SCOPE 「잠금 중 허용 범위」).
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true });
    if (!UUID.test(orderId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    // queueVersion: 환불 화면이 expectedVersion으로 보낸다(환불과 같은 ORDER_SHIPPING 권한·잠금 중 허용)
    const order = await getOrder(prisma, ctx, orderId);
    return NextResponse.json({ ...order, queueVersion: await getRefundVersion(prisma, ctx) });
  } catch (e) {
    return errorResponse(e);
  }
}
