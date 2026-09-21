import type { Metadata } from "next";
import { ogImages } from "@/lib/og";
import { AdSlot } from "@/components/AdSlot";
import { RelatedCalculators } from "@/components/RelatedCalculators";
import { TimeRanking } from "@/components/TimeRanking";

export const metadata: Metadata = {
  title: "인생 시간 랭킹",
  description: "기대여명과 생활시간조사로 계산한 남은 인생의 활동별 시간 순위",
  alternates: {
    canonical: "/ranking/"
  },
  openGraph: {
    url: "/ranking/",
    title: "인생 시간 랭킹",
    description: "기대여명과 생활시간조사로 계산한 남은 인생의 활동별 시간 순위",
    images: ogImages("ranking", "인생 시간 랭킹")
  },
  twitter: {
    card: "summary_large_image",
    title: "인생 시간 랭킹",
    description: "기대여명과 생활시간조사로 계산한 남은 인생의 활동별 시간 순위",
    images: ogImages("ranking", "인생 시간 랭킹")
  }
};

export default function RankingPage() {
  return (
    <main className="pageShell">
      <TimeRanking />
      <AdSlot slot="calculatorBottom" />
      <RelatedCalculators current="/ranking/" />
    </main>
  );
}
