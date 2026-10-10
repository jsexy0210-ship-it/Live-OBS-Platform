import type { Metadata } from "next";
import { Landing, type LandingPlan } from "../../../components/public/Landing";
import { prisma } from "../../../lib/server/db";
import { getPublicPlan } from "../../../lib/server/billing/plans";
import { brandingMetadata } from "../../../lib/server/branding/metadata";

// 요금은 요청마다 서버 요금제에서 읽는다(빌드 때 고정하지 않음)
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return brandingMetadata("landing");
}

// PF-001 서비스 소개(랜딩). 요금을 읽지 못해도 화면은 열린다.
export default async function AboutPage() {
  let plans: LandingPlan[] = [];
  let pricingStatus: "available" | "unavailable" | "error" = "unavailable";
  try {
    const result = await getPublicPlan(prisma);
    plans = result?.plans ?? [];
    if (plans.length > 0) pricingStatus = "available";
  } catch {
    pricingStatus = "error";
  }
  return <Landing plans={plans} pricingStatus={pricingStatus} />;
}
