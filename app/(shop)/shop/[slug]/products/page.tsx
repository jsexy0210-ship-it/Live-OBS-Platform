import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ShopFrame from "../../../../../components/shop/ShopFrame";
import ShopState from "../../../../../components/shop/ShopState";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { sortKey } from "../_lib/catalog";
import ProductListing, { pageNumber } from "../_lib/ProductListing";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ sort?: string; page?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const shop = await findActiveShop((await params).slug);
  return { title: shop ? `전체 상품 · ${shop.shopName}` : "전체 상품" };
}

// SH-002 상품 목록(전체 상품). 상품 분류(카테고리)가 생기면 분류별 목록을 더한다.
export default async function ShopProductsPage({ params, searchParams }: Props) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  const sp = await searchParams;
  const open = await shopOpen(prisma, shop.id);
  return (
    <ShopFrame slug={shop.slug} shopName={shop.shopName}>
      {!open ? (
        <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 이용할 수 있어요." />
      ) : (
        <div className="shop-wrap">
          <ProductListing
            sellerId={shop.id}
            title="전체 상품"
            path={`/shop/${encodeURIComponent(shop.slug)}/products`}
            sort={sortKey(sp.sort)}
            page={pageNumber(sp.page)}
            empty="아직 올라온 상품이 없어요."
          />
        </div>
      )}
    </ShopFrame>
  );
}
