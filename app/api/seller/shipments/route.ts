import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { listShipments, shipOrders } from "../../../../lib/server/orders/shipments";

// 파트너스 배송 처리 목록. 쿼리: tab(ready·in_transit·delivered, 기본 ready), q, from·to(KST 날짜), cursor, limit(기본 50, 최대 200). ORDER_SHIPPING 권한.
// 잠금 중에도 이미 받은 주문은 처리할 수 있다(PRODUCT_SCOPE 「잠금 중 허용 범위」).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = new URL(req.url).searchParams;
    const r = await listShipments(prisma, ctx, { tab: p.get("tab"), q: p.get("q"), from: p.get("from"), to: p.get("to"), cursor: p.get("cursor"), limit: p.get("limit") });
    if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json({ shipments: r.shipments, nextCursor: r.nextCursor }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 송장 입력·일괄 입력. 본문 { items: [{ orderId, courier, trackingNumber }] }(1~100건). 주문별 결과 { results }.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
  const body = await readJson<{ items: unknown }>(req);
  const r = await shipOrders(prisma, ctx, body.items);
  if (!r.ok) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return NextResponse.json({ results: r.results });
});
