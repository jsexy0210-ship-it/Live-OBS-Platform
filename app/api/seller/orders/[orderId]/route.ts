import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../lib/server/http/route";
import { getOrder } from "../../../../../lib/server/orders/read";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const { orderId } = await params;
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    if (!UUID.test(orderId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json(await getOrder(prisma, ctx, orderId));
  } catch (e) {
    return errorResponse(e);
  }
}
