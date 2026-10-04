import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { deliverOrders } from "../../../../../lib/server/orders/shipments";

// 배송 완료 처리(한 건·여러 건). 본문 { orderIds: [...] }(1~100건). 주문별 결과 { results }. ORDER_SHIPPING 권한, 잠금 중에도 가능.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const body = await readJson<{ orderIds: unknown }>(req);
  const r = await deliverOrders(prisma, ctx, body.orderIds);
  if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json({ results: r.results });
});
