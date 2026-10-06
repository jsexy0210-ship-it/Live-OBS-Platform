import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AddressesView from "../../../../../../components/shop/AddressesView";
import { findActiveShop } from "../../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "배송지 관리" };

// SH-027 배송지 관리. 본인 배송지 조회·정리는 잠긴 쇼핑몰에서도 열린다(API와 같은 기준).
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  return <AddressesView slug={shop.slug} />;
}
