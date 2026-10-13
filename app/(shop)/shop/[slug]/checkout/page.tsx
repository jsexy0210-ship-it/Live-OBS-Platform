import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import CheckoutView from "../../../../../components/shop/CheckoutView";
import ShopLocked from "../../../../../components/shop/ShopLocked";
import { COOKIE_NAMES } from "../../../../../lib/server/auth/policy";
import { resolveBuyerSession } from "../../../../../lib/server/auth/session";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "주문서" };

// SH-005 주문서: 장바구니 「주문하기」가 ?ids=로 보낸 줄을 /cart/checkout으로 받아 배송지·주문 닉네임·쿠폰·동의를 받고 주문을 만든다(결제 대기까지).
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  const session = await resolveBuyerSession(prisma, (await cookies()).get(COOKIE_NAMES.buyer)?.value, shop.id);
  return (await shopOpen(prisma, shop.id)) ? (
    <Suspense>
      <CheckoutView slug={shop.slug} memberNickname={session?.member.broadcastNickname ?? ""} />
    </Suspense>
  ) : (
    <ShopLocked slug={shop.slug} />
  );
}
