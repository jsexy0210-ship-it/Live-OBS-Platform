import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { listCategoryProducts, reorderCategoryProducts } from "../../../../../../lib/server/shop-category/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ categoryId: string }> };
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

// 카테고리 안 진열 순서(SA-016). 응답 { products: [{ productId, code, name, status, sortOrder, thumbnailUrl }] }(직접 지정한 지우지 않은 상품)
export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const { categoryId } = await params;
    if (!UUID.test(categoryId)) return notFound();
    return NextResponse.json({ products: await listCategoryProducts(prisma, ctx, categoryId) });
  } catch (e) {
    return errorResponse(e);
  }
}

// 본문 { productIds: [그 카테고리 상품 전부, 새 순서] }. 목록이 지금과 다르면 409 invalid_category_order.
export const PUT = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { categoryId } = await params;
  if (!UUID.test(categoryId)) return notFound();
  const r = await reorderCategoryProducts(prisma, ctx, categoryId, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 409 });
  return NextResponse.json({ products: r.value });
});
