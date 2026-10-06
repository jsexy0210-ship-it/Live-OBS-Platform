import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, readJson, sessionToken } from "../../../../lib/server/http/route";
import { SHOP_PROFILE_MESSAGES, readShopProfile, updateShopProfile } from "../../../../lib/server/seller-settings/shopProfile";

// 쇼핑몰 정보(SA-060). 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 권한 직원만(그 밖 403).
// 응답: { profile: { shopName, shopTagline, operatingState, topNotice, homeBenefitBannerVisible, usageGuide, primaryAddress("DEFAULT"|"CUSTOM"), primaryDomain(읽기 전용: 소유 확인된 내 도메인 | null) } }.
// PUT 본문(보낸 것만 바꾼다): { shopName?(1~20자), shopTagline?(40자·null이면 지움), operatingState?("OPEN"|"PREPARING"|"PAUSED": 준비 중·일시 정지면 구매자에게 안내 화면만, 새 주문 차단),
//   topNotice?(한 줄 60자·null이면 안 보임), homeBenefitBannerVisible?(boolean), usageGuide?(여러 줄 1000자·null이면 지움), primaryAddress?("DEFAULT"|"CUSTOM": CUSTOM은 소유 확인된 도메인이 있어야) }.
// 위반은 400 invalid_shop_profile, CUSTOM인데 확인된 도메인이 없으면 400 no_verified_domain.
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
