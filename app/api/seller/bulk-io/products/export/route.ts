import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { bulkErrorBody, bulkFailureStatus, exportProductsCsv } from "../../../../../../lib/server/shop-bulk-io/service";

// 상품 내보내기(CSV, PRODUCT_MANAGE): 지우지 않은 상품 전부(5000개까지). 양식과 같은 열이라 고쳐서 다시 올릴 수 있다(새 상품으로 등록). 개인정보 없음. 내려받으면 로그 추적에 남긴다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const r = await exportProductsCsv(prisma, ctx);
    if (!r.ok) return noStore(NextResponse.json(bulkErrorBody(r.reason), { status: bulkFailureStatus(r.reason) }));
    return noStore(new Response(r.value.csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename*=UTF-8''%EC%83%81%ED%92%88-%EB%AA%A9%EB%A1%9D.csv", "X-Product-Count": String(r.value.count) } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
