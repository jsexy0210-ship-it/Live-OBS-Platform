import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import EventPopup from "../../../../components/shop/EventPopup";
import HomeBanner from "../../../../components/shop/HomeBanner";
import ShopFrame from "../../../../components/shop/ShopFrame";
import ShopState from "../../../../components/shop/ShopState";
import { shopOpen } from "../../../../lib/server/buyers/signup";
import { prisma } from "../../../../lib/server/db";
import { visibleShopContent } from "../../../../lib/server/shop-content/service";

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

// SH-001 쇼핑몰 홈(최소). 지금은 홈 배너 슬라이드(SA-064)와 이벤트 팝업(SA-065)만 그린다. 상품·방송 영역은 쇼핑몰 홈 화면 작업에서 붙인다.
// 쇼핑몰이 없거나 운영 중이 아니면 404, 이용이 막혔으면(구독 만료·스토어 운영 권한 없음) 안내 화면.
export default async function ShopHomePage({ params }: Params) {
  const { slug } = await params;
  const shop = await findShop(slug);
  if (!shop) notFound();
  const content = (await shopOpen(prisma, shop.id)) ? await visibleShopContent(prisma, slug, "home") : null;
  return (
    <ShopFrame shopName={shop.shopName}>
      {!content ? (
        <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 이용할 수 있어요." />
      ) : (
        <div className="col" style={{ width: 1080, maxWidth: "100%", gap: 16 }}>
          <EventPopup popups={content.popups} />
          <HomeBanner banners={content.banners} />
          <section className="card pad col" style={{ gap: 6 }}>
            <h1 className="t-hl1">{shop.shopName}</h1>
            <p className="t-l2 c-alt" style={{ margin: 0 }}>
              상품은 곧 여기에서 볼 수 있어요.
            </p>
            <Link className="btn btn-sm btn-out" href={`/shop/${encodeURIComponent(slug)}/signup`} style={{ alignSelf: "flex-start", marginTop: 6 }}>
              회원가입
            </Link>
          </section>
        </div>
      )}
    </ShopFrame>
  );
}
