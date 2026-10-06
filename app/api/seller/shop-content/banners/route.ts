import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { CONTENT_MESSAGES, createBanner, getBannerInterval, listBanners } from "../../../../../lib/server/shop-content/service";

// 홈 배너 목록·추가. 조회·변경 모두 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 직원만(그 밖 403), 플랜 기능 STORE_OPERATIONS.
// POST 본문은 lib/server/shop-content/service.ts parseBanner. 검사에 걸리면 400 { error, message }.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json({ banners: await listBanners(prisma, ctx), intervalSec: await getBannerInterval(prisma, ctx) }));
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await createBanner(prisma, ctx, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: CONTENT_MESSAGES[r.reason] }, { status: r.reason === "too_many" ? 409 : 400 });
  return NextResponse.json({ banner: r.banner }, { status: 201 });
});
