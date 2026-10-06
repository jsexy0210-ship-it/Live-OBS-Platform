import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { publicShopProfile } from "../../../../../lib/server/seller-settings/shopProfile";

// 구매자 쇼핑몰 공개 정보(로그인 없음, SA-060). 응답 { shopName, shopTagline, operatingState(OPEN|PREPARING|PAUSED), topNotice(한 줄, 없으면 null),
// homeBenefitBannerVisible, usageGuide(이용안내·교환·환불 정책 글, 없으면 null), primaryDomain(내 도메인을 대표 주소로 골랐고 확인됐으면 호스트, 아니면 null) }.
// 승인된 쇼핑몰만, 아니면 404. 하단 채널 주소·사업자 정보는 바닥글 값(shop-legal-notice의 footerNotice)이다.
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const profile = await publicShopProfile(prisma, slug);
  if (!profile) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(profile, { headers: { "cache-control": "public, max-age=30" } });
}
