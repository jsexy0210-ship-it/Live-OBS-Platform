import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SearchBox from "../../../../../components/shop/SearchBox";
import ShopState from "../../../../../components/shop/ShopState";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { publicCategories } from "../../../../../lib/server/shop-category/service";
import { sortKey } from "../_lib/catalog";
import { parseFilters } from "../_lib/filters";
import ListSide from "../_lib/ListSide";
import ProductListing, { pageNumber } from "../_lib/ProductListing";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ q?: string; sort?: string; page?: string; cats?: string; inStock?: string; live?: string; minPrice?: string; maxPrice?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const shop = await findActiveShop((await params).slug);
  return { title: shop ? `상품 검색 · ${shop.shopName}` : "상품 검색" };
}

// SH-002 상품 검색: 상품 이름·검색 태그·유사어로 찾은 상품(판매 중·품절). 검색어는 50자까지. 입력 칸은 자동완성·최근·인기 검색어(SearchBox).
export default async function ShopSearchPage({ params, searchParams }: Props) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  const sp = await searchParams;
  const q = (typeof sp.q === "string" ? sp.q : "").trim().slice(0, 50);
  const open = await shopOpen(prisma, shop.id);
  const path = `/shop/${encodeURIComponent(shop.slug)}/search`;
  const categories = (await publicCategories(prisma, shop.slug)) ?? [];
  const filters = parseFilters(sp, categories);
  const sort = sortKey(sp.sort, !!q);
  return (
    <>
      {!open ? (
        <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 이용할 수 있어요." />
      ) : (
        <div className="shop-wrap">
          <SearchBox slug={shop.slug} q={q} path={path} />
          {q && (
            <div className="shop-plist">
              <ListSide slug={shop.slug} tree={categories} path={path} q={q} sort={sort} filters={filters} />
              <div className="shop-plist-main">
                <ProductListing
                  slug={shop.slug}
                  title={`‘${q}’ 검색 결과`}
                  path={path}
                  q={q}
                  sort={sort}
                  filters={filters}
                  tree={categories}
                  page={pageNumber(sp.page)}
                  empty="찾는 상품이 없어요. 다른 검색어로 찾아보세요."
                />
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
