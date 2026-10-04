import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { COOKIE_NAMES } from "../../../../../lib/server/auth/policy";
import { resolveBuyerSession } from "../../../../../lib/server/auth/session";
import { prisma } from "../../../../../lib/server/db";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

// 잠긴 쇼핑몰이어도 받은 쿠폰·알림 설정은 볼 수 있게 연다(각 화면 기준과 같음). 없는 쇼핑몰만 404.
async function findShop(slug: string) {
  return prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, slug: true, shopName: true } });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const shop = await findShop((await params).slug);
  return { title: shop ? `내 정보 · ${shop.shopName}` : "내 정보" };
}

// SH-020 마이페이지(지금 있는 화면만 링크). 주문 내역·적립금·배송지 화면이 생기면 목록에 더한다.
// 로그인하지 않았으면 로그인 화면으로 보내고, 로그인하면 여기로 돌아온다.
export default async function ShopMyPage({ params }: Params) {
  const shop = await findShop((await params).slug);
  if (!shop) notFound();
  const base = `/shop/${encodeURIComponent(shop.slug)}`;
  const session = await resolveBuyerSession(prisma, (await cookies()).get(COOKIE_NAMES.buyer)?.value, shop.id);
  if (!session) redirect(`${base}/login?next=${encodeURIComponent(`${base}/me`)}`);
  const links = [
    { href: `${base}/coupons`, label: "쿠폰함" },
    { href: `${base}/me/notifications`, label: "알림 설정" },
  ];
  return (
    <>
      <section className="card shop-card col shop-my">
        <h1 className="t-h1">내 정보</h1>
        <p className="t-l1 c-alt">{session.member.name}님, 반가워요.</p>
        <nav aria-label="내 정보 메뉴" className="shop-my-list">
          {links.map((l) => (
            <Link key={l.href} href={l.href}>
              {l.label}
            </Link>
          ))}
        </nav>
      </section>
    </>
  );
}
