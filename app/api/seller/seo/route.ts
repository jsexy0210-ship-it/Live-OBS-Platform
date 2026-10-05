import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { SHOP_SEO_MESSAGES, readShopSeo, updateShopSeo } from "../../../../lib/server/seller-settings/shopSeo";

// 쇼핑몰 검색 노출(SA-067, SHOP_SETTINGS). 응답·본문 키: searchTitle, searchDescription, indexingEnabled, sitemapEnabled,
// productTitleTemplate, productDescriptionTemplate, googleVerification, naverVerification. PUT은 빼면 지금 값 유지, 문자 값은 빈 값·null이면 지운다.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ seo: await readShopSeo(prisma, ctx) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateShopSeo(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: SHOP_SEO_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ seo: r.seo });
});
