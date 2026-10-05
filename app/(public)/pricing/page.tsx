import type { Metadata } from "next";
import { Pricing } from "../../../components/public/Pricing";
import type { LandingPlan } from "../../../components/public/Landing";
import { getPublicPlan } from "../../../lib/server/billing/plans";
import { prisma } from "../../../lib/server/db";

// 요금은 요청마다 서버 요금제에서 읽는다(빌드 때 고정하지 않음)
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "요금 안내 · ONQ", description: "판매 수수료 없이 월 구독료만 내요. 모두 부가세 포함이에요." };

export default async function PricingPage() {
  let plans: LandingPlan[] = [];
  try {
    plans = (await getPublicPlan(prisma))?.plans ?? [];
  } catch {
    plans = [];
  }
  return <Pricing plans={plans} />;
}
