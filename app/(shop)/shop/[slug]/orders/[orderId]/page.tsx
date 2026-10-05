import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import OrderView from "../../../../../../components/shop/OrderView";
import { findActiveShop } from "../../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "주문 상세" };

// SH-007 주문 완료·주문 상세(?done=1이면 방금 주문한 안내). 본인 주문만 API가 돌려준다. 잠긴 쇼핑몰이어도 기존 주문 조회는 연다(API와 같은 기준).
export default async function Page({ params }: { params: Promise<{ slug: string; orderId: string }> }) {
  const { slug, orderId } = await params;
  const shop = await findActiveShop(slug);
  if (!shop) notFound();
  return (
    <Suspense>
      <OrderView slug={shop.slug} orderId={orderId} />
    </Suspense>
  );
}
