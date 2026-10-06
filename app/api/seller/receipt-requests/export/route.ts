import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { exportSellerReceiptRequests } from "../../../../../lib/server/receipts/manual";

// 영수증·세금계산서 내려받기(SA-024 「이번 달 내려받기」, RECEIPT_TAX). 목록과 같은 조건(status·kind·from·to·field·q)에 month(YYYY-MM)를 주면 그 달 1일~말일(KST)로 채운다. 최대 5,000건, UTF-8(BOM) CSV, 번호는 뒤 4자리만.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "ORDER_FOLLOWUP" });
    const p = new URL(req.url).searchParams;
    const g = (k: string) => p.get(k);
    const r = await exportSellerReceiptRequests(prisma, ctx, { status: g("status"), kind: g("kind"), from: g("from"), to: g("to"), field: g("field"), q: g("q"), month: g("month") }, requestMeta(req));
    if (!r.ok) return noStore(NextResponse.json({ error: "invalid_filter", message: "기간 또는 검색어를 확인해 주십시오" }, { status: 400 }));
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="receipts-${day}.csv"` } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
