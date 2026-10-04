import { prisma } from "../../../../../../../lib/server/db";
import { imageResponse } from "../../../../../../../lib/server/shop-content/image";
import { publicShopImage } from "../../../../../../../lib/server/shop-content/service";

// 구매자 화면 배너·팝업 이미지. 로그인 없이 읽는다. 지금 보이는 배너·팝업이 쓰는 이미지만(예약·종료·숨김 항목, 다른 쇼핑몰 이미지는 404).
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; imageId: string }> }) {
  const { slug, imageId } = await ctx.params;
  const row = await publicShopImage(prisma, slug, imageId);
  if (!row) return new Response("not found", { status: 404, headers: { "x-content-type-options": "nosniff" } });
  return imageResponse(req, row, "public");
}
