import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";
import { imageResponse } from "../../../../../../lib/server/shop-content/image";
import { sellerShopImage } from "../../../../../../lib/server/shop-content/service";

// 파트너스 관리자 미리보기용 이미지(저장 전 이미지 포함). 같은 쇼핑몰·조회 권한(SHOP_SETTINGS)만, 다른 쇼핑몰 이미지는 404.
export async function GET(req: Request, { params }: { params: Promise<{ imageId: string }> }) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return imageResponse(req, await sellerShopImage(prisma, ctx, (await params).imageId), "private");
  } catch (e) {
    return errorResponse(e);
  }
}
