import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ReviewWrite from "../../../../../../components/shop/ReviewWrite";
import ShopState from "../../../../../../components/shop/ShopState";
import ShopLocked from "../../../../../../components/shop/ShopLocked";
import { shopOpen } from "../../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../../lib/server/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }>; searchParams: Promise<{ item?: string; review?: string }> };

async function findShop(slug: string) {
  const shop = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, slug: true, shopName: true, status: true } });
  return shop && shop.status === "ACTIVE" ? shop : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const shop = await findShop((await params).slug);
  return { title: shop ? `리뷰 쓰기 · ${shop.shopName}` : "리뷰 쓰기" };
}

// SH-029 리뷰 쓰기(?item=주문 상품) · 고치기(?review=리뷰). 이용이 막힌 쇼핑몰(구독 만료·스토어 운영 권한 없음)은 안내 화면.
export default async function ShopReviewWritePage({ params, searchParams }: Params) {
  const shop = await findShop((await params).slug);
  if (!shop) notFound();
  const q = await searchParams;
  const item = typeof q.item === "string" ? q.item : null;
  const review = typeof q.review === "string" ? q.review : null;
  const open = await shopOpen(prisma, shop.id);
  return (
    <>
      {!open ? (
        <ShopLocked slug={shop.slug} />
      ) : !item && !review ? (
        <ShopState title="리뷰를 쓸 상품을 골라 주세요" body="내 리뷰에서 리뷰를 기다리는 상품을 골라 주세요." />
      ) : (
        <ReviewWrite slug={shop.slug} itemId={item} reviewId={item ? null : review} />
      )}
    </>
  );
}
