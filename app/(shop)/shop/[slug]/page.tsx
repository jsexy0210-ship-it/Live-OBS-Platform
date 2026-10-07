import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import EventPopup from "../../../../components/shop/EventPopup";
import HomeBanner from "../../../../components/shop/HomeBanner";
import { ProductCard } from "../../../../components/shop/ProductCard";
import HomeProductActions from "../../../../components/shop/HomeProductActions";
import { kstDate } from "../../../../components/shop/kstDate";
import ShopLocked from "../../../../components/shop/ShopLocked";
import { shopOpen } from "../../../../lib/server/buyers/signup";
import { prisma } from "../../../../lib/server/db";
import { publicHome } from "../../../../lib/server/shop-display/service";
import { shopLiveStatus } from "../../../../lib/server/shop/live";
import { visibleShopContent } from "../../../../lib/server/shop-content/service";
import { publicNotices } from "../../../../lib/server/shop-notice/service";
import "../../../../components/shop/ShopHome.css";
import { formatDateTime } from "../../../../lib/client/format";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

async function findShop(slug: string) {
  const shop = await prisma.seller.findUnique({ where: { slug }, select: { id: true, shopName: true, status: true, homeBenefitBannerVisible: true } });
  return shop && shop.status === "ACTIVE" ? shop : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const shop = await findShop((await params).slug);
  return { title: shop?.shopName ?? "쇼핑몰" };
}

// SH-001 FINAL v322: 홈 배너 → 판매자가 정한 진열 영역 → 공지.
// 인기 순위는 산식이 확정되기 전까지 최근 HIT로 대체하지 않는다.
// 진열 순서·노출·품절·가격은 목록과 같은 공개 서비스를 사용한다.
// 쇼핑몰이 없거나 운영 중이 아니면 404, 이용이 막혔으면(구독 만료·스토어 운영 권한 없음) 안내 화면.
export default async function ShopHomePage({ params }: Params) {
  const { slug } = await params;
  const shop = await findShop(slug);
  if (!shop) notFound();
  const content = (await shopOpen(prisma, shop.id)) ? await visibleShopContent(prisma, slug, "home") : null;
  const [home, live, notices] = content ? await Promise.all([
    publicHome(prisma, slug, { recentBroadcastProducts: true }), shopLiveStatus(prisma, slug), publicNotices(prisma, slug, null),
  ]) : [null, null, null];
  const productIds = [...new Set(home?.sections.flatMap(s => s.products.map(p => p.id)) ?? [])];
  const [options, waiting, upcoming] = content ? await Promise.all([
    prisma.productOption.findMany({ where: { sellerId: shop.id, productId: { in: productIds }, deletedAt: null }, select: { id: true, productId: true, name: true } }),
    live?.live ? prisma.queueItem.count({ where: { sellerId: shop.id, status: "WAITING" } }) : Promise.resolve(0),
    prisma.youtubeLiveLink.findFirst({ where: { sellerId: shop.id, status: "UPCOMING", scheduledStartAt: { not: null } }, select: { scheduledStartAt: true }, orderBy: { scheduledStartAt: "asc" } }),
  ]) : [[], 0, null];
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
          <div className="shop-home-banner">
            {content.banners.length ? <HomeBanner banners={content.banners} intervalSec={content.bannerIntervalSec} /> : (
              <div className="shop-home-hero">
                <small>{live?.live ? "지금 방송 중" : "방송 안내"}</small>
                <b>{live?.live ? live.title || "지금 라이브 방송 중이에요" : "지금은 방송이 없어요"}</b>
                <span>{live?.live ? `주문하면 방송 순서대로 열어 드려요 · 지금 ${waiting}명이 기다리고 있어요` : upcoming?.scheduledStartAt ? `다음 방송 ${formatDateTime(upcoming.scheduledStartAt.toISOString())} · 주문하면 다음 방송에서 순서대로 열어 드려요` : "상품과 방송 소식은 이 쇼핑몰에서 확인할 수 있어요"}</span>
                <div><Link className="btn" href={`${base}/products${live?.live ? "?live=1" : ""}`}>{live?.live ? "방송 중 상품 보기" : "상품 보기"}</Link>{live?.watchUrl && <a className="btn" href={live.watchUrl} target="_blank" rel="noopener noreferrer">유튜브로 보기</a>}</div>
                {!live?.live && <Link className="btn" href={`${base}/me/notifications`}>방송 시작 알림 받기</Link>}
              </div>
            )}
            <aside className="shop-home-side" aria-label="이번 주 HIT 카드">
              {shop.homeBenefitBannerVisible && <div><small>회원 혜택</small><b>등급이 오를수록 커지는 혜택</b><span>회원 등급에 따른 혜택을 확인해 보세요</span></div>}
              <div><small>인기 카드</small><b>이번 주 HIT 카드</b><span>방송에서 나온 당첨 카드를 모아 봐요</span></div>
              <div><small>공지</small><b>{pinned?.title || "아직 공지가 없어요"}</b>{pinned && <span>{kstDate(pinned.createdAt)}</span>}</div>
            </aside>
          </div>
          {home?.sections.map((section, i) => <section className={`shop-sec shop-home-products shop-home-kind-${section.kind.toLowerCase()}`} key={`${section.kind}-${section.categoryId ?? i}`} aria-labelledby={`home-products-${i}`}>
            <div className="shop-sec-head"><h2 id={`home-products-${i}`}>{section.kind === "LIVE" && !live?.live && section.title === "방송 중 상품" ? "최근 방송 상품" : section.title}</h2><span className="shop-home-sub">{section.kind === "LIVE" ? live?.live ? "지금 방송에서 여는 상품이에요" : "최근 방송에서 연 상품이에요" : section.kind === "RECOMMENDED" ? "판매자가 고른 순서" : section.kind === "NEW" ? "새로 올라온 상품이에요" : ""}</span><Link className="shop-more" href={`${base}/products${section.kind === "NEW" ? "?sort=new" : section.categoryId ? `?category=${section.categoryId}` : ""}`}>더 보기 ›</Link></div>
            <ul className="pc-grid" aria-label={section.title}>{section.products.map(p => {
              const choices = options.filter(o => o.productId === p.id);
              return <ProductCard key={p.id} p={{ ...p, unitLabel: choices.length === 1 ? choices[0].name : null }} href={`${base}/products/${p.id}`}><div className="shop-home-badges">{p.isLive && !p.soldOut && <span>방송 중</span>}</div><HomeProductActions slug={slug} productId={p.id} optionId={choices.length === 1 ? choices[0].id : null} soldOut={p.soldOut} /></ProductCard>;
            })}</ul>
          </section>)}
          {!home?.sections.length && <section className="shop-sec"><div className="shop-sec-head"><h2>전체 상품</h2></div><p className="shop-empty">아직 올라온 상품이 없어요.</p></section>}
          <section className="shop-sec shop-home-notices" aria-labelledby="home-notices-title">
            <div className="shop-sec-head"><h2 id="home-notices-title">공지</h2><Link className="shop-more" href={`${base}/help`}>더 보기 ›</Link></div>
            <table><thead><tr><th>구분</th><th>제목</th><th>날짜</th></tr></thead><tbody>{notices?.notices.length ? notices.notices.slice(0, 3).map(n => <tr key={n.id}><td>{n.isPinned ? "공지" : n.category || "안내"}</td><td><Link href={`${base}/help/notices/${n.id}`}>{n.title}</Link></td><td>{kstDate(n.createdAt)}</td></tr>) : <tr><td colSpan={3}>아직 공지가 없어요.</td></tr>}</tbody></table>
          </section>
        </div>
      )}
    </>
  );
}
