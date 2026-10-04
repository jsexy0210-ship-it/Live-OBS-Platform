import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../../lib/server/http/route";
import { PRODUCT_IMAGE_MESSAGES, reorderProductImages } from "../../../../../../../lib/server/products/images";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ productId: string }> };

// 순서 바꾸기. 본문 { imageIds: [이 상품 사진 전부, 새 순서] }(첫 번째가 대표 사진). 목록이 지금과 다르면 409. 응답 { images }.
export const PUT = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId } = await params;
  if (!UUID.test(productId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await reorderProductImages(prisma, ctx, productId, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: PRODUCT_IMAGE_MESSAGES[r.reason] }, { status: 409 });
  return NextResponse.json({ images: r.images });
});
