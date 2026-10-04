import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ShopState from "../../../../../components/shop/ShopState";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { publicCategories } from "../../../../../lib/server/shop-category/service";
import { categoryParam, sortKey } from "../_lib/catalog";
import ProductListing, { pageNumber } from "../_lib/ProductListing";
import { findActiveShop } from "../_lib/shop";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ category?: string; sort?: string; page?: string }> };

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
  if (!open) return <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 이용할 수 있어요." />;
  const base = `/shop/${encodeURIComponent(shop.slug)}`;
  const categories = (await publicCategories(prisma, shop.slug)) ?? [];
  const categoryId = categoryParam(sp.category);
  const current = categoryId ? categories.flatMap((c) => [{ ...c, parent: null as string | null }, ...c.children.map((x) => ({ ...x, children: [], parent: c.id as string | null }))]).find((c) => c.id === categoryId) : null;
  if (categoryId && !current) notFound();
  const list = (
    <ProductListing
    slug={shop.slug}
    title={current?.name ?? "전체 상품"}
    path={`${base}/products`}
    sort={sortKey(sp.sort)}
    page={pageNumber(sp.page)}
    categoryId={current?.id}
    empty={current ? "이 분류에는 아직 상품이 없어요." : "아직 올라온 상품이 없어요."}
  />
  );
  const expanded = current ? (current.parent ?? current.id) : null; // 펼쳐 보일 대분류
  return (
    <div className="shop-wrap shop-plist">
      <aside className="shop-sidecat" aria-label="카테고리">
        <p className="shop-sidecat-h">전체 카테고리</p>
        <Link href={`${base}/products`} aria-current={!current ? "page" : undefined}>
          전체
        </Link>
        {categories.map((c) => (
          <div key={c.id}>
            <Link href={`${base}/products?category=${c.id}`} aria-current={current?.id === c.id ? "page" : undefined}>
              {c.name}
            </Link>
            {expanded === c.id &&
              c.children.map((x) => (
                <Link key={x.id} className="sub" href={`${base}/products?category=${x.id}`} aria-current={current?.id === x.id ? "page" : undefined}>
                  {x.name}
                </Link>
              ))}
          </div>
        ))}
      </aside>
      <div className="shop-plist-main">{list}</div>
    </div>
  );
}
