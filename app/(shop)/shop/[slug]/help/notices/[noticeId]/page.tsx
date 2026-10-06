import type { Metadata } from "next";
import { notFound } from "next/navigation";
import NoticeView from "../../../../../../../components/shop/NoticeView";
import ShopLocked from "../../../../../../../components/shop/ShopLocked";
import { shopOpen } from "../../../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../../../lib/server/db";
import { findActiveShop } from "../../../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "공지" };

// 공지 상세. 비공개·없는 공지는 API가 404를 주고 화면은 「찾을 수 없는 공지예요」를 보인다.
export default async function Page({ params }: { params: Promise<{ slug: string; noticeId: string }> }) {
  const { slug, noticeId } = await params;
  const shop = await findActiveShop(slug);
  if (!shop) notFound();
  return (await shopOpen(prisma, shop.id)) ? (
    <NoticeView slug={shop.slug} noticeId={noticeId} />
  ) : (
    <ShopLocked slug={shop.slug} />
  );
}
