import type { Metadata } from "next";
import { Features } from "../../../components/public/Features";
import type { LandingPlan } from "../../../components/public/Landing";
import { getPublicPlan } from "../../../lib/server/billing/plans";
import { prisma } from "../../../lib/server/db";

// 맺음 문구의 체험 일수는 요청마다 서버 요금제에서 읽는다
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "기능 안내 · ONQ", description: "쇼핑몰, 방송 주문대기, 방송 화면, 적립금, 알림, 도우미를 한 계정으로 써요." };

export default async function FeaturesPage() {
  let plans: LandingPlan[] = [];
  try {
    plans = (await getPublicPlan(prisma))?.plans ?? [];
  } catch {
    plans = [];
  }
  return <Features plans={plans} />;
}
