import { notFound } from "next/navigation";
import SignupForm from "../../../../../components/shop/SignupForm";
import ShopLocked from "../../../../../components/shop/ShopLocked";
import { SIGNUP_CONSENT_VERSIONS, currentConsentDocs } from "../../../../../lib/server/buyers/consent";
import { rejoinDaysToAgree } from "../../../../../lib/server/buyers/rejoin";
import { shopOpen } from "../../../../../lib/server/buyers/signup";
import { prisma } from "../../../../../lib/server/db";
import { identityProvider } from "../../../../../lib/server/identity/registry";

export const dynamic = "force-dynamic";

export default async function SignupLayout({ children, params }: { children: React.ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const shop = await prisma.seller.findUnique({ where: { slug }, select: { id: true, shopName: true, status: true } });
  if (!shop || shop.status !== "ACTIVE") notFound();
  if (!(await shopOpen(prisma, shop.id))) return <ShopLocked slug={slug} />;
  const docs = await currentConsentDocs(prisma, shop.id);
  const consent = {
    termsVersion: docs.terms.version,
    privacyVersion: docs.privacy.version,
    rejoinRetentionVersion: SIGNUP_CONSENT_VERSIONS.rejoinRetention,
    marketingVersion: SIGNUP_CONSENT_VERSIONS.marketing,
    rejoinDays: await rejoinDaysToAgree(prisma, shop.id),
  };
  return <><SignupForm slug={slug} shopName={shop.shopName} consent={consent} identityProviderReady={identityProvider() !== null} />{children}</>;
}
