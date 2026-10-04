import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { errorResponse, mutation, sessionToken } from "../../../../../../../lib/server/http/route";
import { deleteProductImage, sellerProductImage } from "../../../../../../../lib/server/products/images";
import { imageResponse } from "../../../../../../../lib/server/shop-content/image";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ productId: string; imageId: string }> };
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

// 파트너스 관리자 미리보기(private 캐시). 지운 상품·다른 판매자 사진은 404.
export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const { productId, imageId } = await params;
    if (!UUID.test(productId) || !UUID.test(imageId)) return notFound();
    const row = await sellerProductImage(prisma, ctx, productId, imageId);
    return row ? imageResponse(req, row, "private") : notFound();
  } catch (e) {
    return errorResponse(e);
  }
}

// 사진 지우기. 남은 사진 순서를 0부터 다시 매긴다. 응답 { images }.
export const DELETE = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId, imageId } = await params;
  if (!UUID.test(productId) || !UUID.test(imageId)) return notFound();
  return NextResponse.json(await deleteProductImage(prisma, ctx, productId, imageId));
});
