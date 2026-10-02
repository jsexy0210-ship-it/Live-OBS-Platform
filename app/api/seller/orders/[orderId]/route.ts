import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { getOrder } from "../../../../../lib/server/orders/read";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await params;
    // 잠금 중에도 이미 받은 주문은 처리할 수 있다(대표님 결정 2026-10-02, PRODUCT_SCOPE 「잠금 중 허용 범위」).
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), new Date(), { allowUnpaid: true });
    if (!UUID.test(orderId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(await getOrder(prisma, ctx, orderId));
  } catch (e) {
    return errorResponse(e);
  }
}
