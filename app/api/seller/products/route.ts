import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../lib/server/orders/messages";
import { createProduct, listProducts } from "../../../../lib/server/products/manage";

// 판매자 상품 목록(?status·display(shown·hidden)·stock(out: 재고 0, low: 1~5)·q(상품·옵션 이름 검색, 대소문자 무시, 50자까지)·code(상품 id 또는 옵션 SKU)
// ·stockDeductMode(재고 차감 시점 ORDER·PAYMENT)·createdFrom·createdTo(KST YYYY-MM-DD)·sort(newest·sales·price_asc·price_desc)·categoryId(하위 포함)·cursor·limit,
// 응답 { products(soldQuantity 포함), nextCursor })·등록(PRODUCT_MANAGE). 마스터 대리 조회는 목록·조회만. 잠긴 판매자는 상품을 다룰 수 없다(새 판매 차단, PRODUCT_SCOPE 「잠금 중 허용 범위」).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const q = new URL(req.url).searchParams;
    const r = await listProducts(prisma, ctx, Object.fromEntries(["status", "display", "stock", "q", "code", "stockDeductMode", "createdFrom", "createdTo", "sort", "categoryId", "cursor", "limit"].map((k) => [k, q.get(k) ?? undefined])));
    if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
    return NextResponse.json(r.value);
  } catch (e) {
    return errorResponse(e);
  }
}

// 본문: { name, description?, price, status?(기본 DRAFT), sortOrder?, options?: [{ name, priceDelta?, stock?, sku?, sortOrder? }] }
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await createProduct(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json(r.value, { status: 201 });
});
