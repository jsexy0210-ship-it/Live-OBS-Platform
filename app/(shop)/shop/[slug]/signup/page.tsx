import type { Metadata } from "next";
import { notFound } from "next/navigation";
import ShopFrame from "../../../../../components/shop/ShopFrame";
import SignupForm from "../../../../../components/shop/SignupForm";
import ShopState from "../../../../../components/shop/ShopState";
import { rejoinDaysToAgree } from "../../../../../lib/server/buyers/rejoin";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { identityProvider } from "../../../../../lib/server/identity/registry";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }> };

async function findShop(slug: string) {
  const shop = await prisma.seller.findUnique({ where: { slug }, select: { id: true, shopName: true, status: true } });
  return shop && shop.status === "ACTIVE" ? shop : null;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const shop = await findShop((await params).slug);
  return { title: shop ? `회원가입 · ${shop.shopName}` : "회원가입" };
}

// SH-011 구매자 회원가입. 쇼핑몰이 없거나 운영 중이 아니면 404, 이용이 막혔거나(구독 만료)
// 본인확인 설정이 없으면(운영에 포트원 키 없음 = API 503) 입력 전에 상태 화면을 보여 준다.
export default async function ShopSignupPage({ params }: Params) {
  const { slug } = await params;
  const shop = await findShop(slug);
  if (!shop) notFound();
  const open = await shopOpen(prisma, shop.id);
  const identityReady = identityProvider() !== null;
  // 재가입 제한을 켠 쇼핑몰은 가입 때 보관 동의를 따로 받는다(기간을 안내)
  const rejoinDays = await rejoinDaysToAgree(prisma, shop.id);
  return (
    <ShopFrame shopName={shop.shopName}>
      {!open ? (
        <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 가입할 수 있어요." />
      ) : !identityReady ? (
        <ShopState title="본인확인 서비스 준비 중이에요" body="휴대폰 본인확인을 할 수 있게 되면 바로 가입할 수 있어요. 잠시 뒤 다시 와 주세요." />
      ) : (
        <SignupForm slug={slug} rejoin={rejoinDays === null ? null : { days: rejoinDays }} />
      )}
    </ShopFrame>
  );
}
