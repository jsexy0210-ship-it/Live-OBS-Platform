import type { Metadata } from "next";
import { AdSlot } from "@/components/AdSlot";
import { RelatedCalculators } from "@/components/RelatedCalculators";
import { SurvivalCalculator } from "@/components/SurvivalCalculator";

export const metadata: Metadata = {
  title: "생존 잔량",
  description: "소득 중단 시 현금 생존기간 계산",
  alternates: {
    canonical: "/survival/"
  },
  openGraph: {
    url: "/survival/",
    title: "생존 잔량",
    description: "소득 중단 시 현금 생존기간 계산"
  }
};

export default function SurvivalPage() {
  return (
    <main className="pageShell">
      <SurvivalCalculator />
      <AdSlot slot="calculatorBottom" />
      <RelatedCalculators current="/survival/" />
    </main>
  );
}
