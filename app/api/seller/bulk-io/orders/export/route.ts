import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { EXPORT_MESSAGES, exportFailureStatus, exportOrdersCsv } from "../../../../../../lib/server/shop-bulk-io/exports";

// 주문 내보내기(SA-018, CSV, ORDER_SHIPPING): ?from=YYYY-MM-DD&to=YYYY-MM-DD(KST, 둘 다 필요, 최대 366일), 5,000건까지. 주문·결제·배송 상태·송장·금액만이고 받는 분 정보는 없다. 내려받으면 처리 이력·로그 추적에 남는다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = new URL(req.url).searchParams;
    const r = await exportOrdersCsv(prisma, ctx, { from: p.get("from"), to: p.get("to") });
    if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: EXPORT_MESSAGES[r.reason] }, { status: exportFailureStatus(r.reason) }));
    return noStore(new Response(r.value.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="orders-${p.get("from")}_${p.get("to")}.csv"`, "X-Row-Count": String(r.value.count) } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
