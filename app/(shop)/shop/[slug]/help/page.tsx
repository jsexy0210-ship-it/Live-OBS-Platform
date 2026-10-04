import type { Metadata } from "next";
import { notFound } from "next/navigation";
import HelpView from "../../../../../components/shop/HelpView";
import ShopState from "../../../../../components/shop/ShopState";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "고객센터" };

// SH-030 고객센터: 공지·자주 묻는 질문(API는 운영 중인 쇼핑몰만 열어 준다). 이용안내·문의하기는 해당 기능이 생기면 더한다.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  return (await shopOpen(prisma, shop.id)) ? (
    <HelpView slug={shop.slug} />
  ) : (
    <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 이용할 수 있어요." />
  );
}
