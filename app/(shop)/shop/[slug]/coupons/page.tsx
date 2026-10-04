import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CouponBox from "../../../../../components/shop/CouponBox";
import ShopFrame from "../../../../../components/shop/ShopFrame";
import ShopState from "../../../../../components/shop/ShopState";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
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

// SH-028 내 쿠폰함(마이페이지). 쇼핑몰이 없거나 운영 중이 아니면 404, 이용이 막혔으면(구독 만료·스토어 운영 권한 없음) 안내 화면.
export default async function ShopCouponsPage({ params }: Params) {
  const shop = await findShop((await params).slug);
  if (!shop) notFound();
  const open = await shopOpen(prisma, shop.id);
  return (
    <ShopFrame shopName={shop.shopName}>
      {open ? <CouponBox slug={shop.slug} /> : <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 쿠폰함을 볼 수 있어요." />}
    </ShopFrame>
  );
}
