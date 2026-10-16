import type { Metadata } from "next";
import { notFound } from "next/navigation";
import CartView from "../../../../../components/shop/CartView";
import ShopLocked from "../../../../../components/shop/ShopLocked";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "장바구니" };

// SH-004 장바구니: 로그인 구매자의 장바구니(/api/shop/{slug}/cart)를 표 형태로 보여 준다. 배송비·적립 예정은 장바구니 API가 주지 않아 보이지 않는다.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  return (await shopOpen(prisma, shop.id)) ? (
    <CartView slug={shop.slug} />
  ) : (
    <ShopLocked slug={shop.slug} />
  );
}
