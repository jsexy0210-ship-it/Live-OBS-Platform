import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { COOKIE_NAMES } from "../../../../../lib/server/auth/policy";
import { resolveBuyerSession } from "../../../../../lib/server/auth/session";
import { myGroups } from "../../../../../components/shop/myGroups";
import GradeCard from "../../../../../components/shop/member-grades/GradeCard";
import { prisma } from "../../../../../lib/server/db";
import { buyerGradeStatus } from "../../../../../lib/server/shop-member-grades/benefits";
import { readBuyerRewardBalance } from "../../../../../lib/server/rewards/balance";
import { buyerCouponBox } from "../../../../../lib/server/shop-coupons/service";
import { listBuyerOrders } from "../../../../../lib/server/orders/buyer";
import MyLogoutButton from "../../../../../components/shop/MyLogoutButton";

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

// SH-020 내 정보 허브(J-3). 본인·상점 범위의 기존 주문·혜택 조회를 요약한다.
// 로그인하지 않았으면 로그인 화면으로 보내고, 로그인하면 여기로 돌아온다.
export default async function ShopMyPage({ params }: Params) {
  const shop = await findShop((await params).slug);
  if (!shop) notFound();
  const base = `/shop/${encodeURIComponent(shop.slug)}`;
  const session = await resolveBuyerSession(prisma, (await cookies()).get(COOKIE_NAMES.buyer)?.value, shop.id);
  if (!session) redirect(`${base}/login?next=${encodeURIComponent(`${base}/me`)}`);
  const groups = myGroups(base);
  const scope = { sellerId: shop.id, buyerMemberId: session.member.id };
  const [grade, rewards, coupons, orders, queueItems] = await Promise.all([
    buyerGradeStatus(prisma, scope),
    readBuyerRewardBalance(prisma, scope),
    buyerCouponBox(prisma, scope, 1),
    listBuyerOrders(prisma, scope, { limit: 4 }),
    prisma.queueItem.findMany({
      where: { sellerId: shop.id, status: { in: ["WAITING", "OPENING"] }, order: { is: { ...scope, legalHoldAt: null } } },
      select: { orderId: true, status: true, position: true },
      orderBy: { position: "asc" },
    }),
  ]);
  const recent = orders.ok ? orders.value.orders : [];
  const next = queueItems.find((q) => q.status === "OPENING") ?? queueItems[0];
  const ahead = next?.status === "WAITING" ? await prisma.queueItem.count({ where: { sellerId: shop.id, status: "WAITING", position: { lt: next.position } } }) : 0;
  const waitingCount = new Set(queueItems.map((q) => q.orderId)).size;
  const couponCount = coupons.usable.filter((c) => c.state === "usable").length;
  return (
    <section className="shop-my">
      <h1 className="t-h1">내 정보</h1>
      <p className="t-l1 c-alt">주문과 혜택을 한눈에 확인하세요.</p>
      <div className="shop-my-layout">
        <nav aria-label="내 정보 메뉴" className="shop-my-menu">
          <strong>{session.member.name}님</strong>
          {groups.map((g) => (
            <div key={g.title} className="shop-my-list">
              <p className="shop-my-g">{g.title}</p>
              {g.links.map((l) => <Link key={l.href} href={l.href}>{l.label}</Link>)}
            </div>
          ))}
          <MyLogoutButton slug={shop.slug} />
        </nav>
        <div className="shop-my-main">
          <div className="shop-my-profile">
            <div className="shop-my-avatar" aria-hidden="true">{session.member.name.slice(0, 1)}</div>
            <div><strong>{session.member.name}</strong><p>{grade ? `${grade.gradeName} 회원` : "반가워요"}</p></div>
            <Link className="btn btn-sm btn-out" href={`${base}/me/profile`}>수정</Link>
          </div>
          <div className="shop-my-stats">
            <Link href={`${base}/orders`}><span>기다리는 주문</span><strong>{waitingCount}건</strong>{next?.status === "WAITING" && <small>앞에 {ahead}명</small>}</Link>
            <Link href={`${base}/me/rewards`}><span>적립금</span><strong>{rewards.balance.toLocaleString("ko-KR")}원</strong></Link>
            <Link href={`${base}/coupons`}><span>쿠폰</span><strong>{couponCount}장</strong></Link>
            {grade && <div className="shop-my-grade"><GradeCard status={grade} /></div>}
          </div>
          {next && <p className="shop-my-queue" role="status">{next.status === "OPENING" ? "지금 내 차례예요. 방송을 확인해 주세요." : `곧 내 차례예요 · 앞에 ${ahead}명 남았어요. 방송을 켜 두세요.`}</p>}
          <section className="shop-my-recent" aria-labelledby="shop-my-recent-title">
            <div><h2 id="shop-my-recent-title">최근 주문</h2><Link href={`${base}/orders`}>더 보기 ›</Link></div>
            {recent.length === 0 ? <p>아직 주문이 없어요. 방송 중인 상품을 주문하면 여기에서 순서를 볼 수 있어요.</p> : (
              <table className="shop-my-orders"><thead><tr><th>주문일 · 번호</th><th>상품 정보</th><th>상태</th><th>관리</th></tr></thead><tbody>
                {recent.map((o) => <tr key={o.id}>
                  <td><time dateTime={o.createdAt.toISOString()}>{o.createdAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time><Link href={`${base}/orders/${o.id}`}>{o.orderNoLabel}</Link></td>
                  <td>{o.items.map((item, idx) => <div className="shop-my-order-item" key={idx}><span className="shop-my-order-thumb">{"imageUrl" in item && typeof item.imageUrl === "string" ? <Image src={item.imageUrl} alt="" width={44} height={44} unoptimized /> : "사진"}</span><span><strong>{item.productNameSnapshot}</strong><small>{item.optionNameSnapshot} × {item.quantity}</small></span></div>)}<small>결제 금액 {o.totalAmount.toLocaleString("ko-KR")}원</small></td>
                  <td>{o.queue?.status === "OPENING" ? "개봉 중" : o.queue?.status === "WAITING" ? `개봉 대기 · 앞에 ${o.queue.aheadCount}명` : o.shipment?.status === "DELIVERED" ? "배송 완료" : o.shipment?.status === "IN_TRANSIT" ? "배송 중" : o.status === "PENDING_PAYMENT" ? "결제 전" : o.status === "CANCELLED" ? "취소됨" : o.status === "REFUNDED" ? "환불됨" : "결제 완료"}</td>
                  <td><Link className="btn btn-sm btn-out" href={`${base}/orders/${o.id}`}>상세 보기</Link></td>
                </tr>)}
              </tbody></table>
            )}
          </section>
        </div>
      </div>
    </section>
  );
}
