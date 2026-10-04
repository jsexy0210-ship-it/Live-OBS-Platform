import { buyerScope } from "../../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../../lib/server/db";
import { noStore } from "../../../../../../../lib/server/http/route";
import { reviewImageResponse } from "../../../../../../../lib/server/product-reviews/image";
import { buyerReviewImage } from "../../../../../../../lib/server/product-reviews/service";

// 내가 올린 리뷰 사진(저장 전 미리보기, 숨긴 리뷰 포함). 남의 사진은 404.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string; imageId: string }> }) {
  const { slug, imageId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  return reviewImageResponse(await buyerReviewImage(prisma, b.scope, imageId), "private");
}
