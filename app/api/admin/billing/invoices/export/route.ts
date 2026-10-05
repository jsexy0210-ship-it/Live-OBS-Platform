import { NextResponse } from "next/server";
import { exportBillingInvoices } from "../../../../../../lib/server/admin/billingInvoices";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 청구·결제 내역 내보내기(MA-024, CSV). 목록과 같은 조건(month·from·to·state·failedOnly·plan·q·sellerId), 최대 5,000건. 내려받은 사실은 로그 추적(admin.billing.export).
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const g = (k: string) => p.get(k);
    const r = await exportBillingInvoices(prisma, admin, { month: g("month"), from: g("from"), to: g("to"), state: g("state"), plan: g("plan"), q: g("q"), failedOnly: g("failedOnly"), sellerId: g("sellerId") }, requestMeta(req));
    if (!r.ok) return noStore(NextResponse.json({ error: "invalid_query" }, { status: 400 }));
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="billing-${r.range.from.replace(/-/g, "")}-${r.range.to.replace(/-/g, "")}.csv"`, "x-export-truncated": r.truncated ? "1" : "0" } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
