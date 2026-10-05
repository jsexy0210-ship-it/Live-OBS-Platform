import { buyerScope } from "../../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../../lib/server/db";
import { noStore } from "../../../../../../../lib/server/http/route";
import { reviewImageResponse } from "../../../../../../../lib/server/product-reviews/image";
import { buyerReturnImage } from "../../../../../../../lib/server/shop-returns/service";

// 내가 올린(또는 내 신청에 붙은) 신청 사진. 남의 사진은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; imageId: string }> }) {
  const { slug, imageId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  return reviewImageResponse(await buyerReturnImage(prisma, b.scope, imageId), "private");
}
