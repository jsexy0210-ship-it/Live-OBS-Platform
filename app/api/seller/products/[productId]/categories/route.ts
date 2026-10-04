import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";
import { productCategoryIds, setProductCategories } from "../../../../../../lib/server/shop-category/service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ productId: string }> };
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

// 상품에 지정한 카테고리. 응답 { categoryIds }
export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const { productId } = await params;
    if (!UUID.test(productId)) return notFound();
    return NextResponse.json({ categoryIds: await productCategoryIds(prisma, ctx, productId) });
  } catch (e) {
    return errorResponse(e);
  }
}

// 본문: { categoryIds: [...] }(0~10개). 지정 목록을 통째로 바꾼다.
export const PUT = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId } = await params;
  if (!UUID.test(productId)) return notFound();
  const r = await setProductCategories(prisma, ctx, productId, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason, "formal"), { status: 400 });
  return NextResponse.json({ categoryIds: r.value });
});
