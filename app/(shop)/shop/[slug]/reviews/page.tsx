import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ReviewMine from "../../../../../components/shop/ReviewMine";
import ShopFrame from "../../../../../components/shop/ShopFrame";
import { prisma } from "../../../../../lib/server/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

async function findShop(slug: string) {
  const shop = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { slug: true, shopName: true, status: true } });
  return shop && shop.status === "ACTIVE" ? shop : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const shop = await findShop((await params).slug);
  return { title: shop ? `내 리뷰 · ${shop.shopName}` : "내 리뷰" };
}

// SH-029 내 리뷰(마이페이지). 잠긴 쇼핑몰이어도 받은 답글·숨김 사유는 본다(쓰기·신고는 API가 막음). 쇼핑몰이 없거나 운영 중이 아니면 404.
export default async function ShopReviewsPage({ params }: Params) {
  const shop = await findShop((await params).slug);
  if (!shop) notFound();
  return (
    <ShopFrame shopName={shop.shopName}>
      <ReviewMine slug={shop.slug} />
    </ShopFrame>
  );
}
