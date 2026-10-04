import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";
import { listStockMovements } from "../../../../../lib/server/products/stockMovements";

// 재고 이력(?productId·optionId·cursor·limit, 응답 { movements, nextCursor }, PRODUCT_MANAGE). 최근순.
// 항목: 상품·옵션 이름, 증감, 결과 재고, 유형(주문·취소·환불·직접 변경), 사유, 처리자(직원 이름 또는 「구매자 주문」), 연결 주문 id, 시각.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const q = new URL(req.url).searchParams;
    const r = await listStockMovements(prisma, ctx, {
      productId: q.get("productId"),
      optionId: q.get("optionId"),
      cursor: q.get("cursor"),
      limit: q.get("limit"),
    });
    if (!r.ok) return noStore(NextResponse.json(orderErrorBody(r.reason), { status: 400 }));
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
