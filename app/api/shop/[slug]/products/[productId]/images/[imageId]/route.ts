import { prisma } from "../../../../../../../../lib/server/db";
import { publicProductImage } from "../../../../../../../../lib/server/products/images";
import { imageResponse } from "../../../../../../../../lib/server/shop-content/image";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response("not found", { status: 404, headers: { "x-content-type-options": "nosniff", "cache-control": "no-cache" } });

// 구매자 쇼핑몰 상품 사진. 로그인 없이 읽는다. 운영 중인 쇼핑몰의 보이는 상품(판매 중·품절) 사진만, 아니면 404.
// 주소의 v가 지금 사진 해시와 같으면 1년 immutable.
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; productId: string; imageId: string }> }) {
  const { slug, productId, imageId } = await ctx.params;
  if (!UUID.test(productId) || !UUID.test(imageId)) return notFound();
  const row = await publicProductImage(prisma, slug, productId, imageId);
  return row ? imageResponse(req, row, "public") : notFound();
}
