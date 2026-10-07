import type { Metadata } from "next";
import { Pricing } from "../../../components/public/Pricing";
import type { LandingPlan } from "../../../components/public/Landing";
import { getPublicPlan } from "../../../lib/server/billing/plans";
import { policyValue } from "../../../lib/server/admin/platformPolicy";
import { readPlatformBusinessInfo } from "../../../lib/server/admin/platformBusinessInfo";
import { prisma } from "../../../lib/server/db";
import type { PublicCompanyInfo } from "../../../components/public/PublicFrame";

// 요금은 요청마다 서버 요금제에서 읽는다(빌드 때 고정하지 않음)
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "요금 안내 · ONQ", description: "판매 수수료 없이 월 구독료만 내요. 모두 부가세 포함이에요." };

export default async function PricingPage() {
  let plans: LandingPlan[] = [];
  let billingPolicy: { paymentRetryCount: number; overdueLockDays: number; lockToCloseDays: number } | null = null;
  let companyInfo: PublicCompanyInfo | null = null;
  const [plansResult, retriesResult, graceResult, closeResult, companyResult] = await Promise.allSettled([
    getPublicPlan(prisma),
    policyValue(prisma, "paymentRetryCount"),
    policyValue(prisma, "overdueLockDays"),
    policyValue(prisma, "lockToCloseDays"),
    readPlatformBusinessInfo(prisma),
  ]);
  if (plansResult.status === "fulfilled") plans = plansResult.value?.plans ?? [];
  if (retriesResult.status === "fulfilled" && graceResult.status === "fulfilled" && closeResult.status === "fulfilled") {
    billingPolicy = { paymentRetryCount: retriesResult.value, overdueLockDays: graceResult.value, lockToCloseDays: closeResult.value };
  }
  if (companyResult.status === "fulfilled") {
    const { name, representative, businessNumber, mailOrderNumber, address, phone } = companyResult.value;
    companyInfo = { name, representative, businessNumber, mailOrderNumber, address, phone };
  }
  return <Pricing plans={plans} billingPolicy={billingPolicy} companyInfo={companyInfo} />;
}
