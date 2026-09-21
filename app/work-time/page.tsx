import type { Metadata } from "next";
import { ogImages } from "@/lib/og";
import { AdSlot } from "@/components/AdSlot";
import { RelatedCalculators } from "@/components/RelatedCalculators";
import { WorkTimeCalculator } from "@/components/WorkTimeCalculator";

export const metadata: Metadata = {
  title: "회사 누적시간",
  description: "근무와 출퇴근에 사용한 누적시간 계산",
  alternates: {
    canonical: "/work-time/"
  },
  openGraph: {
    url: "/work-time/",
    title: "회사 누적시간",
    description: "근무와 출퇴근에 사용한 누적시간 계산",
    images: ogImages("work-time", "회사 누적시간")
  },
  twitter: {
    card: "summary_large_image",
    title: "회사 누적시간",
    description: "근무와 출퇴근에 사용한 누적시간 계산",
    images: ogImages("work-time", "회사 누적시간")
  }
};

export default function WorkTimePage() {
  return (
    <main className="pageShell">
      <WorkTimeCalculator />
      <AdSlot slot="calculatorBottom" />
      <RelatedCalculators current="/work-time/" />
    </main>
  );
}
