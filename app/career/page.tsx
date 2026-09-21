import type { Metadata } from "next";
import { ogImages } from "@/lib/og";
import { AdSlot } from "@/components/AdSlot";
import { CareerCalculator } from "@/components/CareerCalculator";
import { RelatedCalculators } from "@/components/RelatedCalculators";

export const metadata: Metadata = {
  title: "커리어 위치",
  description: "산업 평균 대비 월급 위치, 산업 고용 흐름, 최저임금·물가 지표",
  alternates: {
    canonical: "/career/"
  },
  openGraph: {
    url: "/career/",
    title: "커리어 위치",
    description: "산업 평균 대비 월급 위치, 산업 고용 흐름, 최저임금·물가 지표",
    images: ogImages("career", "커리어 위치")
  },
  twitter: {
    card: "summary_large_image",
    title: "커리어 위치",
    description: "산업 평균 대비 월급 위치, 산업 고용 흐름, 최저임금·물가 지표",
    images: ogImages("career", "커리어 위치")
  }
};

export default function CareerPage() {
  return (
    <main className="pageShell">
      <CareerCalculator />
      <AdSlot slot="calculatorBottom" />
      <RelatedCalculators current="/career/" />
    </main>
  );
}
