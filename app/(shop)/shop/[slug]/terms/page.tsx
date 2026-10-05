import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ShopLegal from "../../../../../components/shop/ShopLegal";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { publicLegalOf } from "../../../../../lib/server/shop-legal/service";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "이용약관" };

// 쇼핑몰 이용약관: 파트너스가 입력해 게시한 본문만 보여 주고, 게시 전에는 준비 중 안내.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  // 운영 중이 아닌 쇼핑몰은 안내만(API와 같은 기준)
  return <ShopLegal kind="terms" doc={(await shopOpen(prisma, shop.id)) ? await publicLegalOf(prisma, shop.id, "TERMS") : null} />;
}
