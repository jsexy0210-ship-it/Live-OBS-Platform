import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import ProductDetail from "../../../../../../components/shop/ProductDetail";
import ShopState from "../../../../../../components/shop/ShopState";
import { COOKIE_NAMES } from "../../../../../../lib/server/auth/policy";
import { resolveBuyerSession } from "../../../../../../lib/server/auth/session";
import { shopOpen } from "../../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../../lib/server/db";
import { publicCategories } from "../../../../../../lib/server/shop-category/service";
import { shopProductDetail } from "../../../../../../lib/server/products/shopCatalog";
import { recordProductView } from "../../../../../../lib/server/stats/funnel";
import { findActiveShop } from "../../_lib/shop";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string; productId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, productId } = await params;
  const p = await shopProductDetail(prisma, slug, productId);
  return { title: p ? `${p.name} · ${(await findActiveShop(slug))?.shopName ?? ""}` : "상품" };
}

// SH-003 상품 상세: 사진·옵션·수량·장바구니·바로 구매·찜(ProductDetail)과 상세 글·사진, 배송 안내. 운영 중이 아니면 안내 화면, 보이지 않는 상품은 404.
export default async function ShopProductPage({ params }: Props) {
  const { slug, productId } = await params;
  const shop = await findActiveShop(slug);
  if (!shop) notFound();
  if (!(await shopOpen(prisma, shop.id))) return <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 이용할 수 있어요." />;
  const token = (await cookies()).get(COOKIE_NAMES.buyer)?.value;
  const session = await resolveBuyerSession(prisma, token, shop.id);
  const product = await shopProductDetail(prisma, shop.slug, productId, session?.member.gradeId);
  if (!product) notFound();
  if (session) await recordProductView(prisma, { sellerId: shop.id, buyerMemberId: session.member.id }, productId); // 전환 단계 통계(로그인 회원만, 실패해도 던지지 않음)
  // 경로: 연결된 카테고리 중 트리 순서로 가장 앞선 하나(서버가 그 순서로 준다) → 「대분류 › 소분류」
  const tree = (await publicCategories(prisma, shop.slug)) ?? [];
  const first = product.categories[0];
  const crumb = first
    ? (() => {
        const top = tree.find((c) => c.id === first.id);
        if (top) return [{ id: top.id, name: top.name }];
        const parent = tree.find((c) => c.children.some((x) => x.id === first.id));
        return parent ? [{ id: parent.id, name: parent.name }, { id: first.id, name: first.name }] : [{ id: first.id, name: first.name }];
      })()
    : [];
  return (
    <div className="shop-wrap">
      <ProductDetail slug={shop.slug} loggedIn={!!session} product={JSON.parse(JSON.stringify(product))} crumb={crumb} />
    </div>
  );
}
