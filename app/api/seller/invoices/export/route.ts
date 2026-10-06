import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { exportInvoices } from "../../../../../lib/server/invoices/service";

// 송장 목록 엑셀(CSV) 내려받기(SA-028, ORDER_SHIPPING). 목록과 같은 조건(status·q), 최대 5,000건, UTF-8(BOM). 받는 분 실명·주소는 넣지 않는다. 로그 추적 invoice.export.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = new URL(req.url).searchParams;
    const r = await exportInvoices(prisma, ctx, { status: p.get("status"), q: p.get("q") });
    if (!r.ok) return noStore(NextResponse.json({ error: "invalid_request", message: "요청을 확인해 주십시오" }, { status: 400 }));
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="invoices-${day}.csv"` } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
