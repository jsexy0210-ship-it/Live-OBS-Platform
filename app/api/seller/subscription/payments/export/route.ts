import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { exportBillingRows } from "../../../../../../lib/server/billing/billingRows";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

// 구독·결제 청구 내역 엑셀(CSV) 내려받기(SA-090 「전체 내보내기」). 대표자만, 본인 쇼핑몰 전체(최대 5,000줄, 넘으면 X-Export-Truncated: 1).
// UTF-8(BOM) CSV, 열: 청구월·항목·금액·결제일·상태. 구독 화면과 같이 체험·이용 기간이 끝나도 받을 수 있다. 내려받은 사실은 로그 추적에 남는다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING", allowSuspended: true });
    const r = await exportBillingRows(prisma, ctx, requestMeta(req));
    const day = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10).replace(/-/g, "");
    return noStore(new NextResponse(r.csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="billing-${day}.csv"`, ...(r.truncated ? { "x-export-truncated": "1" } : {}) } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
