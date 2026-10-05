import type { Metadata } from "next";
import { Landing, type LandingPlan } from "../../../components/public/Landing";
import { prisma } from "../../../lib/server/db";
import { getPublicPlan } from "../../../lib/server/billing/plans";

// 요금은 요청마다 서버 요금제에서 읽는다(빌드 때 고정하지 않음)
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "ONQ · 라이브 주문대기와 파트너스 쇼핑몰",
  description: "파트너스별 쇼핑몰과 라이브 방송 주문대기를 하나로. 주문이 들어오면 방송 화면에 줄이 서요."
};

// PF-001 서비스 소개(랜딩). 요금을 읽지 못해도 화면은 열린다.
export default async function AboutPage() {
  let plans: LandingPlan[] = [];
  try {
    plans = (await getPublicPlan(prisma))?.plans ?? [];
  } catch {
    plans = [];
  }
  return <Landing plans={plans} />;
}
