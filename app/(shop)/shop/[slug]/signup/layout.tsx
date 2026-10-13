import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SignupProvider } from "../../../../../components/shop/signup/SignupFlow";
import ShopState from "../../../../../components/shop/ShopState";
import { SIGNUP_CONSENT_VERSIONS, currentConsentDocs } from "../../../../../lib/server/buyers/consent";
import { rejoinDaysToAgree } from "../../../../../lib/server/buyers/rejoin";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { identityProvider } from "../../../../../lib/server/identity/registry";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ slug: string }>; children: React.ReactNode };

async function findShop(slug: string) {
  const shop = await prisma.seller.findUnique({ where: { slug }, select: { id: true, shopName: true, status: true } });
  return shop && shop.status === "ACTIVE" ? shop : null;
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const shop = await findShop((await params).slug);
  return { title: shop ? `회원가입 · ${shop.shopName}` : "회원가입" };
}

// SH-011 구매자 회원가입 4단계(/signup → /signup/verify → /signup/account → /signup/done)의 공통 틀. 이 레이아웃이 가입 상태를 들고 있어 단계를 오가도 입력값이 남는다.
// 쇼핑몰이 없거나 운영 중이 아니면 404, 이용이 막혔으면(구독 만료) 단계 화면 대신 상태 화면. 본인확인 설정이 없으면(운영에 키 없음 = API 503)
// 2단계에서 입력칸과 버튼을 잠그고 「준비 중」으로 안내한다. 로그인한 구매자는 단계 화면이 (본인 정보 조회로 확인해) 홈으로 보낸다.
export default async function SignupLayout({ params, children }: Params) {
  const { slug } = await params;
  const shop = await findShop(slug);
  if (!shop) notFound();
  const open = await shopOpen(prisma, shop.id);
  if (!open) return <ShopState title="지금은 쇼핑몰을 이용할 수 없어요" body="쇼핑몰이 다시 문을 열면 가입할 수 있어요." />;
  const identityReady = identityProvider() !== null;
  // 가입 필수 동의 문서 버전과 재가입 제한 기간(켠 쇼핑몰만). 화면은 본인확인 전에 동의를 받아 함께 보낸다.
  const docs = await currentConsentDocs(prisma, shop.id);
  const consent = {
    termsVersion: docs.terms.version,
    privacyVersion: docs.privacy.version,
    rejoinRetentionVersion: SIGNUP_CONSENT_VERSIONS.rejoinRetention,
    marketingVersion: SIGNUP_CONSENT_VERSIONS.marketing,
    rejoinDays: await rejoinDaysToAgree(prisma, shop.id),
  };
  return (
    <SignupProvider slug={slug} shopName={shop.shopName} consent={consent} identityReady={identityReady}>
      {children}
    </SignupProvider>
  );
}
