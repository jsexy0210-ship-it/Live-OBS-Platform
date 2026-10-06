import type { Metadata } from "next";
import { notFound } from "next/navigation";
import MyInquiriesView from "../../../../../../components/shop/MyInquiriesView";
import { findActiveShop } from "../../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "내 문의" };

// SH-026 내 문의. 받은 답변은 잠긴 쇼핑몰에서도 본다(API와 같은 기준).
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  return <MyInquiriesView slug={shop.slug} />;
}
