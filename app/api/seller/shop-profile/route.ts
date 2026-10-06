import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { SHOP_PROFILE_MESSAGES, readShopProfile, updateShopProfile } from "../../../../lib/server/seller-settings/shopProfile";

// 쇼핑몰 이름·한 줄 소개(SA-060). 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 권한 직원만(그 밖 403). 응답: { profile: { shopName, shopTagline, operatingState } }.
// PUT 본문: { shopName?: string(1~20자), shopTagline?: string | null(40자, 빈 값·null이면 지움), operatingState?: "OPEN" | "PREPARING" | "PAUSED"(준비 중·일시 정지면 구매자에게 안내 화면만 보이고 주문 조회만 열림, 새 주문·결제 차단) }. 빼면 지금 값 유지. 위반은 400 invalid_shop_profile.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return NextResponse.json({ profile: await readShopProfile(prisma, ctx) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateShopProfile(prisma, ctx, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: SHOP_PROFILE_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ profile: r.profile });
});
