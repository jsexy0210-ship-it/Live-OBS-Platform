import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../lib/server/orders/messages";
import { listOptionStock } from "../../../../../lib/server/products/optionStock";

// 옵션 단위 재고 목록(재고 관리 화면, PRODUCT_MANAGE). ?stock=out|low(옵션마다)·q(상품·옵션 이름)·status(상품 상태)·cursor·limit.
// 응답 { options: [{ productId, productName, productStatus, optionId, optionName, sku, stock }], nextCursor }.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
    const q = new URL(req.url).searchParams;
    const r = await listOptionStock(prisma, ctx, {
      status: q.get("status") ?? undefined,
      stock: q.get("stock") ?? undefined,
      q: q.get("q") ?? undefined,
      cursor: q.get("cursor") ?? undefined,
      limit: q.get("limit") ?? undefined,
    });
    if (!r.ok) return noStore(NextResponse.json(orderErrorBody(r.reason), { status: 400 }));
    return noStore(NextResponse.json(r.value));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
