import type { Metadata } from "next";
import { notFound } from "next/navigation";
import MarketingConsent from "../../../../../../components/shop/MarketingConsent";
import { prisma } from "../../../../../../lib/server/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

// 잠긴 쇼핑몰이어도 수신 철회는 열어 둔다(서버 API와 같은 기준). 없는 쇼핑몰만 404.
async function findShop(slug: string) {
  return prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { slug: true, shopName: true } });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const shop = await findShop((await params).slug);
  return { title: shop ? `알림 설정 · ${shop.shopName}` : "알림 설정" };
}

// SH-025 알림 설정(마이페이지): 마케팅 정보 수신 동의를 켜고 끈다. API: GET·PUT /api/shop/{slug}/me/marketing-consent(로그인한 회원만).
export default async function ShopNotificationsPage({ params }: Params) {
  const shop = await findShop((await params).slug);
  if (!shop) notFound();
  return (
    <>
      <MarketingConsent slug={shop.slug} shopName={shop.shopName} />
    </>
  );
}
