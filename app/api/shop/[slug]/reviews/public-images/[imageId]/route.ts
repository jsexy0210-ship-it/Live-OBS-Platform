import { prisma } from "../../../../../../../lib/server/db";
import { shopOpen } from "../../../../../../../lib/server/buyers/signup";
import { reviewImageResponse } from "../../../../../../../lib/server/product-reviews/image";
import { publicReviewImage } from "../../../../../../../lib/server/product-reviews/service";

// 공개 리뷰 사진(로그인 없이). 공개 리뷰에 붙은 사진만, 운영 중인 쇼핑몰만. 숨기면 바로 404(캐시 60초).
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string; imageId: string }> }) {
  const { slug, imageId } = await params;
  const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true } });
  if (!seller || !(await shopOpen(prisma, seller.id))) return reviewImageResponse(null, "public");
  return reviewImageResponse(await publicReviewImage(prisma, seller.id, imageId), "public");
}
