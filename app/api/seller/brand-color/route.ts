import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { BRAND_COLOR_MESSAGES, readBrandColor, updateBrandColor } from "../../../../lib/server/seller-settings/brandColor";

// 쇼핑몰 대표 색상(SA-060, SHOP_SETTINGS). 응답: { brandColor: { color: "#RRGGBB" | null, contrastOnWhite: number | null } }(null이면 플랫폼 기본 강조색).
// PUT 본문: { color: "#RRGGBB" | null }(소문자 가능, 빈 값·null이면 지움). 형식이 틀리면 400 invalid_brand_color, 흰 바탕 대비 3:1 미만이면 400 brand_color_too_light.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ brandColor: await readBrandColor(prisma, ctx) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateBrandColor(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: BRAND_COLOR_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ brandColor: r.brandColor });
});
