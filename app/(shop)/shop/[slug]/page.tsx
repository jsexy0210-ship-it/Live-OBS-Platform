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
import { publicHome } from "../../../../lib/server/shop-display/service";
import { shopLiveStatus } from "../../../../lib/server/shop/live";
import { visibleShopContent } from "../../../../lib/server/shop-content/service";
import { publicNotices } from "../../../../lib/server/shop-notice/service";
import "../../../../components/shop/ShopHome.css";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

async function findShop(slug: string) {
  const shop = await prisma.seller.findUnique({ where: { slug }, select: { id: true, shopName: true, status: true } });
  return shop && shop.status === "ACTIVE" ? shop : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const shop = await findShop((await params).slug);
  return { title: shop?.shopName ?? "쇼핑몰" };
}

// SH-001 FINAL v322: 배너 → 판매자가 정한 진열 영역 → 공지.
// 주간 HIT 순위·혜택 수치는 공급 계약이 없어 임의로 만들지 않는다.
// 쇼핑몰이 없거나 운영 중이 아니면 404, 이용이 막혔으면(구독 만료·스토어 운영 권한 없음) 안내 화면.
export default async function ShopHomePage({ params }: Params) {
  const { slug } = await params;
  const shop = await findShop(slug);
  if (!shop) notFound();
  const content = (await shopOpen(prisma, shop.id)) ? await visibleShopContent(prisma, slug, "home") : null;
  const [home, live, notices] = content ? await Promise.all([
    publicHome(prisma, slug, { recentBroadcastProducts: true }), shopLiveStatus(prisma, slug), publicNotices(prisma, slug, null),
  ]) : [null, null, null];
  const base = `/shop/${encodeURIComponent(slug)}`;
  const pinned = notices?.pinned ?? null;
  return (
    <>
      {!content ? (
        <ShopLocked slug={slug} />
      ) : (
        <div className="shop-wrap shop-home">
          {pinned && (
            <div className="shop-ntc">
              <b>공지</b>
              <Link href={`${base}/help/notices/${pinned.id}`}>{pinned.title}</Link>
              <span>{kstDate(pinned.createdAt)}</span>
            </div>
          )}
          <EventPopup popups={content.popups} />
          <HomeBanner banners={content.banners} intervalSec={content.bannerIntervalSec} />
          {home?.sections.map((section, i) => {
            const title = section.kind === "LIVE" && !live?.live && section.title === "방송 중 상품" ? "최근 방송 상품" : section.title;
            return <section className={`shop-sec shop-home-kind-${section.kind.toLowerCase()}`} key={`${section.kind}-${section.categoryId ?? i}`} aria-labelledby={`home-products-${i}`}>
              <div className="shop-sec-head"><h2 id={`home-products-${i}`}>{title}</h2><span className="shop-home-sub">{section.kind === "LIVE" ? live?.live ? "지금 여는 상품" : "최근 방송에서 연 상품" : section.kind === "RECOMMENDED" ? "판매자가 고른 순서" : section.kind === "NEW" ? "7일 안 등록" : ""}</span><Link className="shop-more" href={`${base}/products${section.kind === "NEW" ? "?sort=new" : section.categoryId ? `?category=${section.categoryId}` : section.kind === "LIVE" && live?.live ? "?live=1" : ""}`}>더 보기 ›</Link></div>
              <ProductGrid products={section.products} label={title} hrefBase={`${base}/products`} />
            </section>;
          })}
          {!home?.sections.length && <section className="shop-sec"><div className="shop-sec-head"><h2>전체 상품</h2></div><p className="shop-empty">아직 올라온 상품이 없어요.</p></section>}
          <section className="shop-sec shop-home-notices" aria-labelledby="home-notices-title">
            <div className="shop-sec-head"><h2 id="home-notices-title">공지</h2><Link className="shop-more" href={`${base}/help`}>더 보기 ›</Link></div>
            <table><tbody>{notices?.notices.length ? notices.notices.slice(0, 3).map(n => <tr key={n.id}><td><Link href={`${base}/help/notices/${n.id}`}>{n.title}</Link></td><td>{kstDate(n.createdAt)}</td></tr>) : <tr><td colSpan={2}>아직 공지가 없어요.</td></tr>}</tbody></table>
          </section>
        </div>
      )}
    </>
  );
}
