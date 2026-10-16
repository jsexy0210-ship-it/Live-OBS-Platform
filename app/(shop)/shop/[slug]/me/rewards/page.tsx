import type { Metadata } from "next";
import { notFound } from "next/navigation";
import RewardsView from "../../../../../../components/shop/RewardsView";
import { findActiveShop } from "../../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "내 적립금" };

// SH-023 내 적립금. 잔액·내역 조회는 잠긴 쇼핑몰에서도 열린다(API me/rewards·me/reward-ledger와 같은 기준).
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  return <RewardsView slug={shop.slug} />;
}
