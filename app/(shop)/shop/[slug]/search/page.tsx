import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ShopState from "../../../../../components/shop/ShopState";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { sortKey } from "../_lib/catalog";
import ProductListing, { pageNumber } from "../_lib/ProductListing";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; sort?: string; page?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const shop = await findActiveShop((await params).slug);
  return { title: shop ? `상품 검색 · ${shop.shopName}` : "상품 검색" };
}

// SH-002 상품 검색: 상품 이름에 검색어가 들어간 상품(판매 중·품절). 검색어는 50자까지.
export default async function ShopSearchPage({ params, searchParams }: Props) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 50);
  const open = await shopOpen(prisma, shop.id);
  const path = `/shop/${encodeURIComponent(shop.slug)}/search`;
  return (
    <>
      {!open ? (
        <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 이용할 수 있어요." />
      ) : (
        <div className="shop-wrap">
          <form className="shop-searchbox" role="search" action={path}>
            <input className="inp" type="search" name="q" defaultValue={q} maxLength={50} placeholder="상품 이름으로 찾아보세요" aria-label="검색어" />
            <button type="submit" className="btn">
              검색
            </button>
          </form>
          {q && (
            <ProductListing
              sellerId={shop.id}
              title={`‘${q}’ 검색 결과`}
              path={path}
              q={q}
              sort={sortKey(sp.sort)}
              page={pageNumber(sp.page)}
              empty="찾는 상품이 없어요. 다른 검색어로 찾아보세요."
            />
          )}
        </div>
      )}
    </>
  );
}
