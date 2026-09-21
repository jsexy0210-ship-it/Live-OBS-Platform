import type { Metadata } from "next";
import { AdSlot } from "@/components/AdSlot";
import { RelatedCalculators } from "@/components/RelatedCalculators";
import { WeekendCalculator } from "@/components/WeekendCalculator";

export const metadata: Metadata = {
  title: "주말 잔량",
  description: "선택한 기준 나이까지 남은 주말 횟수 계산",
  alternates: {
    canonical: "/weekends/"
  },
  openGraph: {
    url: "/weekends/",
    title: "주말 잔량",
    description: "선택한 기준 나이까지 남은 주말 횟수 계산"
  }
};

export default function WeekendPage() {
  return (
    <main className="pageShell">
      <WeekendCalculator />
      <AdSlot slot="calculatorBottom" />
      <RelatedCalculators current="/weekends/" />
    </main>
  );
}
