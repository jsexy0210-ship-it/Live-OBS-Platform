import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ShopLegal from "../../../../../components/shop/ShopLegal";
import { prisma } from "../../../../../lib/server/db";
import { publicLegalOf } from "../../../../../lib/server/shop-legal/service";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "개인정보처리방침" };

// 쇼핑몰 개인정보처리방침: 파트너스가 입력해 게시한 본문만 보여 주고, 게시 전에는 준비 중 안내.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  // 준비 중·일시 정지 중에도 게시된 법정 고지는 읽을 수 있다.
  return <ShopLegal kind="privacy" slug={shop.slug} doc={await publicLegalOf(prisma, shop.id, "PRIVACY")} />;
}
