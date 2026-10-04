import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CouponBox from "../../../../../components/shop/CouponBox";
import ShopFrame from "../../../../../components/shop/ShopFrame";
import { prisma } from "../../../../../lib/server/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

async function findShop(slug: string) {
  const shop = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, slug: true, shopName: true, status: true } });
  return shop && shop.status === "ACTIVE" ? shop : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const shop = await findShop((await params).slug);
  return { title: shop ? `내 쿠폰함 · ${shop.shopName}` : "내 쿠폰함" };
}

// SH-028 내 쿠폰함(마이페이지). 쇼핑몰이 없거나 운영 중이 아니면 404.
// 이용이 막힌 쇼핑몰(구독 만료·스토어 운영 권한 없음)에서도 받은 쿠폰은 읽기 전용으로 보인다(받기·코드 등록만 숨김, API가 shopOpen으로 알려 줌).
export default async function ShopCouponsPage({ params }: Params) {
  const shop = await findShop((await params).slug);
  if (!shop) notFound();
  return (
    <ShopFrame slug={shop.slug} shopName={shop.shopName}>
      <CouponBox slug={shop.slug} />
    </ShopFrame>
  );
}
