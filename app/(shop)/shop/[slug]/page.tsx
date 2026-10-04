import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import EventPopup from "../../../../components/shop/EventPopup";
import HomeBanner from "../../../../components/shop/HomeBanner";
import { ProductGrid } from "../../../../components/shop/ProductCard";
import ShopState from "../../../../components/shop/ShopState";
import { shopOpen } from "../../../../lib/server/buyers/signup";
import { prisma } from "../../../../lib/server/db";
import { visibleShopContent } from "../../../../lib/server/shop-content/service";
import { shopProducts } from "./_lib/catalog";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

const HOME_COUNT = 8;

async function findShop(slug: string) {
  const shop = await prisma.seller.findUnique({ where: { slug }, select: { id: true, shopName: true, status: true } });
  return shop && shop.status === "ACTIVE" ? shop : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const shop = await findShop((await params).slug);
  return { title: shop?.shopName ?? "쇼핑몰" };
}

// SH-001 쇼핑몰 홈: 홈 배너 슬라이드(SA-064)·이벤트 팝업(SA-065) → 상품 격자(판매자가 정한 순서로 앞 8개, 「더 보기」는 전체 상품).
// 진열 영역(SA-016: 추천·신상품·카테고리별)은 상품 진열 기능이 생기면 배너와 격자 사이에 붙인다.
// 쇼핑몰이 없거나 운영 중이 아니면 404, 이용이 막혔으면(구독 만료·스토어 운영 권한 없음) 안내 화면.
export default async function ShopHomePage({ params }: Params) {
  const { slug } = await params;
  const shop = await findShop(slug);
  if (!shop) notFound();
  const content = (await shopOpen(prisma, shop.id)) ? await visibleShopContent(prisma, slug, "home") : null;
  const products = content ? await shopProducts(shop.id) : [];
  const base = `/shop/${encodeURIComponent(slug)}`;
  return (
    <>
      {!content ? (
        <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 이용할 수 있어요." />
      ) : (
        <div className="shop-wrap">
          <EventPopup popups={content.popups} />
          <HomeBanner banners={content.banners} />
          <section className="shop-sec" aria-labelledby="home-products">
            <div className="shop-sec-head">
              <h2 id="home-products">전체 상품</h2>
              {products.length > HOME_COUNT && (
                <Link className="shop-more" href={`${base}/products`}>
                  더 보기
                </Link>
              )}
            </div>
            {products.length === 0 ? (
              <p className="shop-empty">아직 올라온 상품이 없어요.</p>
            ) : (
              <ProductGrid products={products.slice(0, HOME_COUNT)} label="전체 상품" />
            )}
          </section>
        </div>
      )}
    </>
  );
}
