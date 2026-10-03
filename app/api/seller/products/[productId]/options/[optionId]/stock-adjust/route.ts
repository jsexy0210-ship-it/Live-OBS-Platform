import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../../../lib/server/orders/messages";
import { adjustStock } from "../../../../../../../../lib/server/products/stock";

// 수동 재고 증감(이벤트 증정·서비스 등, PRODUCT_MANAGE). 본문: { delta(0이 아닌 정수), reason(필수, 100자 이내), expectedStock?(화면이 본 재고) }.
// 모자라면 409 insufficient_stock, 정수 상한을 넘으면 409 stock_too_large, 그사이 재고가 바뀌었으면 409 stock_conflict(+ currentStock),
// 다른 판매자 옵션은 404.
export const POST = mutation(async (req: Request, { params }: { params: Promise<{ productId: string; optionId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const { productId, optionId } = await params;
  const r = await adjustStock(prisma, ctx, productId, optionId, await readJson(req));
  if (!r.ok) {
    const body = r.currentStock === undefined ? orderErrorBody(r.reason) : { ...orderErrorBody(r.reason), currentStock: r.currentStock };
    return NextResponse.json(body, { status: r.reason === "invalid_stock_adjust" ? 400 : 409 });
  }
  return NextResponse.json(r.value);
});
