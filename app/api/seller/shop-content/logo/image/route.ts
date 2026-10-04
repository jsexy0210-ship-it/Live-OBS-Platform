import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../../../lib/server/http/route";
import { imageResponse } from "../../../../../../lib/server/shop-content/image";
import { sellerLogoImage } from "../../../../../../lib/server/shop-content/logo";

// 파트너스 관리자 미리보기용 로고 이미지(같은 쇼핑몰 계정만, 없으면 404)
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    const row = await sellerLogoImage(prisma, ctx);
    if (!row) return new Response("not found", { status: 404, headers: { "x-content-type-options": "nosniff", "cache-control": "no-store" } });
    return imageResponse(req, row, "private");
  } catch (e) {
    return errorResponse(e);
  }
}
