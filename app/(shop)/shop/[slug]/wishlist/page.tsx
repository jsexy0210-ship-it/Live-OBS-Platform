import type { Metadata } from "next";
import { notFound } from "next/navigation";
import WishlistView from "../../../../../components/shop/WishlistView";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "찜" };

// SH-034 찜. 목록·빼기는 잠긴 쇼핑몰에서도 열고(API와 같은 기준), 찜하기만 막힌다.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  return <WishlistView slug={shop.slug} />;
}
