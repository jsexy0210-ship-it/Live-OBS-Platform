import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { COOKIE_NAMES } from "../../../../../lib/server/auth/policy";
import { resolveBuyerSession } from "../../../../../lib/server/auth/session";
import { myGroups } from "../../../../../components/shop/myGroups";
import MyHub from "../../../../../components/shop/MyHub";
import MyMenu from "../../../../../components/shop/MyMenu";
import ShopLogout from "../../../../../components/shop/ShopLogout";
import { prisma } from "../../../../../lib/server/db";
import { buyerGradeStatus } from "../../../../../lib/server/shop-member-grades/benefits";

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

// SH-020 내 정보 허브(J-3). 지금 있는 화면만 그룹별로 링크한다.
// 로그인하지 않았으면 로그인 화면으로 보내고, 로그인하면 여기로 돌아온다.
export default async function ShopMyPage({ params }: Params) {
  const shop = await findShop((await params).slug);
  if (!shop) notFound();
  const base = `/shop/${encodeURIComponent(shop.slug)}`;
  const session = await resolveBuyerSession(prisma, (await cookies()).get(COOKIE_NAMES.buyer)?.value, shop.id);
  if (!session) redirect(`${base}/login?next=${encodeURIComponent(`${base}/me`)}`);
  const groups = myGroups(base);
  const grade = await buyerGradeStatus(prisma, { sellerId: shop.id, buyerMemberId: session.member.id });
  const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
  const hubGrade = grade ? { name: grade.gradeName, sub: grade.nextGrade ? `${grade.nextGrade.name}까지 ${won(grade.nextGrade.remaining)}` : grade.benefits.length ? grade.benefits.join(" · ") : "" } : null;
  const who = `${session.member.broadcastNickname}${grade ? ` 님 · ${grade.gradeName}` : " 님"}`;
  return (
    <div className="shop-wrap cart-wrap">
      <div className="cart-head">
        <h1>내 정보</h1>
      </div>
      <div className="hub-profile" data-testid={grade ? "grade-card" : undefined}>
        <span className="hub-ava" aria-hidden>
          {session.member.broadcastNickname.slice(0, 1)}
        </span>
        <div className="hub-who">
          <b>{session.member.broadcastNickname}</b>
          {grade && <span className="hub-tag">{grade.gradeName}</span>}
          {hubGrade && (
            <p className="hub-gline">
              내 등급 <b>{hubGrade.name}</b>
              {hubGrade.sub ? ` · ${hubGrade.sub}` : ""}
            </p>
          )}
        </div>
        <Link className="btn btn-out btn-sm" href={`${base}/me/profile`}>
          수정
        </Link>
      </div>
      <div className="my-wrap">
        <MyMenu slug={shop.slug} who={who} />
        <div>
          <MyHub slug={shop.slug} grade={hubGrade} />
          <div className="hub-mlist">
            {groups.map((g) => (
              <nav key={g.title} aria-label={g.title} className="shop-my-list">
                <p className="shop-my-g">{g.title}</p>
                {g.links.map((l) => (
                  <Link key={l.href} href={l.href}>
                    {l.label}
                    <span aria-hidden>›</span>
                  </Link>
                ))}
              </nav>
            ))}
            <div className="shop-my-out">
              <ShopLogout slug={shop.slug} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
