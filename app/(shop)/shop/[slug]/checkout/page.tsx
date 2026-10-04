import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import CheckoutView from "../../../../../components/shop/CheckoutView";
import ShopState from "../../../../../components/shop/ShopState";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "주문서" };

// SH-005 주문서: 장바구니 「주문하기」가 ?ids=로 보낸 줄을 /cart/checkout으로 받아 배송지·쿠폰·동의를 받고 주문을 만든다(결제 대기까지).
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  return (await shopOpen(prisma, shop.id)) ? (
    <Suspense>
      <CheckoutView slug={shop.slug} />
    </Suspense>
  ) : (
    <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 이용할 수 있어요." />
  );
}
