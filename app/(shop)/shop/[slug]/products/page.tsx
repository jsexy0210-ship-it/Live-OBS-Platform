import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ShopLocked from "../../../../../components/shop/ShopLocked";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { publicCategories } from "../../../../../lib/server/shop-category/service";
import { categoryParam, sortKey } from "../_lib/catalog";
import { parseFilters } from "../_lib/filters";
import ListSide from "../_lib/ListSide";
import ProductListing, { pageNumber } from "../_lib/ProductListing";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ category?: string; sort?: string; page?: string; cats?: string; inStock?: string; live?: string; rating4?: string; coupon?: string; minPrice?: string; maxPrice?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const shop = await findActiveShop((await params).slug);
  return { title: shop ? `전체 상품 · ${shop.shopName}` : "전체 상품" };
}

// SH-002 상품 목록: 왼쪽 카테고리(PC)·제목·정렬·격자. ?category=분류 id(대분류는 하위 분류 상품까지), 보이지 않거나 없는 분류는 404.
export default async function ShopProductsPage({ params, searchParams }: Props) {
  const shop = await findActiveShop((await params).slug);
  if (!shop) notFound();
  const sp = await searchParams;
  const open = await shopOpen(prisma, shop.id);
  if (!open) return <ShopLocked slug={shop.slug} />;
  const base = `/shop/${encodeURIComponent(shop.slug)}`;
  const categories = (await publicCategories(prisma, shop.slug)) ?? [];
  const categoryId = categoryParam(sp.category);
  // 2단 트리: 대분류(parent 없음)와 소분류. 현재 분류의 대분류와 경로(대분류 › 소분류)를 구한다
  const top = categories.find((c) => c.id === categoryId) ?? null;
  const parent = top ? null : categories.find((c) => c.children.some((x) => x.id === categoryId)) ?? null;
  const sibling = parent?.children.find((x) => x.id === categoryId) ?? null;
  const current = top ?? sibling;
  if (categoryId && !current) notFound();
  const filters = parseFilters(sp, categories);
  const sort = sortKey(sp.sort);
  const group = top ?? parent; // 칩으로 보여 줄 묶음(대분류와 그 소분류)
  const crumb = parent && sibling ? `${parent.name} › ${sibling.name}` : undefined;
  const chipLink = (id: string | null, label: string, on: boolean) => (
    <Link key={id ?? "all"} className="shop-chip" href={id ? `${base}/products?category=${id}` : `${base}/products`} aria-current={on ? "page" : undefined}>
      {label}
    </Link>
  );
  const chips =
    group && group.children.length > 0 ? (
      <nav className="shop-chips" aria-label={`${group.name} 하위 카테고리`}>
        {chipLink(group.id, "전체", current?.id === group.id)}
        {group.children.map((x) => chipLink(x.id, x.name, current?.id === x.id))}
      </nav>
    ) : null;
  const list = (
    <ProductListing
      slug={shop.slug}
      title={current?.name ?? "전체 상품"}
      crumb={crumb}
      chips={chips}
      path={`${base}/products`}
      sort={sort}
      filters={filters}
      tree={categories}
      page={pageNumber(sp.page)}
      categoryId={current?.id}
      empty={current ? "이 분류에는 아직 상품이 없어요." : "아직 올라온 상품이 없어요."}
    />
  );
  return (
    <div className="shop-wrap shop-plist">
      <ListSide slug={shop.slug} tree={categories} currentId={current?.id} path={`${base}/products`} sort={sort} filters={filters} />
      <div className="shop-plist-main">{list}</div>
    </div>
  );
}
