import { notFound } from "next/navigation";
import ShopFrame from "../../../../../components/shop/ShopFrame";
import ShopState from "../../../../../components/shop/ShopState";
import { findActiveShop } from "./shop";

// 머리·고정 바에서 이어지지만 아직 기능(API)이 없는 화면. 가짜 내용 없이 준비 중임을 알린다.
export default async function ComingSoon({ slug, title, body }: { slug: string; title: string; body: string }) {
  const shop = await findActiveShop(slug);
  if (!shop) notFound();
  return (
    <ShopFrame slug={shop.slug} shopName={shop.shopName}>
      <ShopState title={title} body={body} />
    </ShopFrame>
  );
}
