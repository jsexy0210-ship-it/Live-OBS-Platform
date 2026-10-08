import type { Metadata } from "next";
import { notFound } from "next/navigation";
import HelpView from "../../../../../components/shop/HelpView";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "고객센터" };

// SH-030 고객센터: 준비 중·일시 정지 중에도 공지·이용안내·자주 묻는 질문을 읽을 수 있다.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  return <HelpView slug={shop.slug} />;
}
