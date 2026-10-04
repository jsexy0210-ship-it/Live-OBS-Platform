import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { readBodyLimited } from "../../../../../../lib/server/branding/image";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { getProduct } from "../../../../../../lib/server/products/manage";
import { PRODUCT_IMAGE_MAX_BYTES, PRODUCT_IMAGE_MESSAGES, listProductImages, uploadProductImage } from "../../../../../../lib/server/products/images";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ productId: string }> };
const notFound = () => NextResponse.json({ error: "not_found" }, { status: 404 });

// 상품 사진 목록 { images: [{ id, url, sortOrder, width, height }] }(첫 번째가 대표 사진)
export async function GET(req: Request, { params }: Params) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const { productId } = await params;
    if (!UUID.test(productId)) return notFound();
    await getProduct(prisma, ctx, productId); // 없거나 지운 상품·권한 확인
    return NextResponse.json({ images: await listProductImages(prisma, ctx.sellerId, productId) });
  } catch (e) {
    return errorResponse(e);
  }
}

// 사진 1장 올리기. 본문은 파일 바이트 그대로(Content-Type은 보지 않고 바이트로 형식 확인). 5MB를 넘으면 끝까지 받지 않고 413.
// 응답 201 { image: { id, url, sortOrder, width, height } }. 맨 뒤에 붙는다.
export const POST = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId } = await params;
  if (!UUID.test(productId)) return notFound();
  const bytes = await readBodyLimited(req, PRODUCT_IMAGE_MAX_BYTES);
  if (!bytes) return NextResponse.json({ error: "file_too_large", message: PRODUCT_IMAGE_MESSAGES.file_too_large }, { status: 413 });
  const r = await uploadProductImage(prisma, ctx, productId, bytes, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: PRODUCT_IMAGE_MESSAGES[r.reason] }, { status: r.reason === "too_many_images" ? 409 : 400 });
  return NextResponse.json({ image: r.image }, { status: 201 });
});
