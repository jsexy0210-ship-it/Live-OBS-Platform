import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import EventPopup from "../../../../components/shop/EventPopup";
import HomeBanner from "../../../../components/shop/HomeBanner";
import { ProductGrid } from "../../../../components/shop/ProductCard";
import { kstDate } from "../../../../components/shop/kstDate";
import ShopLocked from "../../../../components/shop/ShopLocked";
import { shopOpen } from "../../../../lib/server/buyers/signup";
import { prisma } from "../../../../lib/server/db";
import { shopProductList } from "../../../../lib/server/products/shopCatalog";
import { visibleShopContent } from "../../../../lib/server/shop-content/service";
import { publicNotices } from "../../../../lib/server/shop-notice/service";

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
  const listed = content ? await shopProductList(prisma, slug, { sort: "recommended", limit: String(HOME_COUNT) }) : null;
  const products = listed?.ok ? listed.value.products : [];
  const base = `/shop/${encodeURIComponent(slug)}`;
  const pinned = content ? (await publicNotices(prisma, slug, null))?.pinned ?? null : null; // 홈 머리 아래 고정 공지 띠
  return (
    <>
      {!content ? (
        <ShopLocked slug={slug} />
      ) : (
        <div className="shop-wrap">
          {pinned && (
            <div className="shop-ntc">
              <b>공지</b>
              <Link href={`${base}/help/notices/${pinned.id}`}>{pinned.title}</Link>
              <span>{kstDate(pinned.createdAt)}</span>
            </div>
          )}
          <EventPopup popups={content.popups} />
          <HomeBanner banners={content.banners} intervalSec={content.bannerIntervalSec} />
          <section className="shop-sec" aria-labelledby="home-products">
            <div className="shop-sec-head">
              <h2 id="home-products">전체 상품</h2>
              {listed?.ok && listed.value.hasMore && (
                <Link className="shop-more" href={`${base}/products`}>
                  더 보기
                </Link>
              )}
            </div>
            {products.length === 0 ? (
              <p className="shop-empty">아직 올라온 상품이 없어요.</p>
            ) : (
              <ProductGrid products={products} label="전체 상품" hrefBase={`${base}/products`} />
            )}
          </section>
        </div>
      )}
    </>
  );
}
