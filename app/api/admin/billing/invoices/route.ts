import { NextResponse } from "next/server";
import { listBillingInvoices } from "../../../../../lib/server/admin/billingInvoices";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";

export const dynamic = "force-dynamic";

// 마스터 청구·결제 내역(MA-024, 구독료, 모든 마스터 역할 조회). ?month=YYYY-MM(없으면 이번 달 KST) 또는 from·to(KST 날짜, 최대 366일)
// &state=PAID|PENDING|RETRYING|OVERDUE|FAILED|REFUNDED|SCHEDULED&failedOnly=1&plan=&q=(쇼핑몰 이름·주소)&sellerId=&cursor=(건너뛸 개수)&limit=(기본 20·최대 100)
// state=RETRYING은 FINAL의 「실패 · 재시도」 선택지로, RETRYING과 종료된 FAILED를 함께 조회한다. OVERDUE는 별도 선택지다.
// → { range, summary { total, paid, failed { retrying, overdue }, pending, refunded, scheduled { estimatedAmount } }, items[], total, nextCursor }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const p = new URL(req.url).searchParams;
    const g = (k: string) => p.get(k);
    const r = await listBillingInvoices(prisma, admin, { month: g("month"), from: g("from"), to: g("to"), state: g("state"), plan: g("plan"), q: g("q"), failedOnly: g("failedOnly"), sellerId: g("sellerId"), cursor: g("cursor"), limit: g("limit") });
    if (!r.ok) return noStore(NextResponse.json({ error: "invalid_query" }, { status: 400 }));
    return noStore(NextResponse.json(r));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
