import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";
import { requireSellerPermission } from "../../../../../../lib/server/tenant/context";
import { templateCsv } from "../../../../../../lib/server/shop-bulk-io/service";

// 상품 일괄 등록 양식(CSV 내려받기, PRODUCT_MANAGE). 열: 상품명·판매가·상태·설명·차감시점·카테고리·옵션명·옵션추가금·재고·SKU. 예시 3줄 포함.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    requireSellerPermission(ctx, "PRODUCT_MANAGE");
    return noStore(new Response(templateCsv(), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename*=UTF-8''%EC%83%81%ED%92%88-%EC%9D%BC%EA%B4%84-%EB%93%B1%EB%A1%9D-%EC%96%91%EC%8B%9D.csv" } }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
