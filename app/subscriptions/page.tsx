import type { Metadata } from "next";
import { ogImages } from "@/lib/og";
import { AdSlot } from "@/components/AdSlot";
import { RelatedCalculators } from "@/components/RelatedCalculators";
import { SubscriptionCalculator } from "@/components/SubscriptionCalculator";

export const metadata: Metadata = {
  title: "구독 누적",
  description: "구독 서비스 누적 결제액 계산",
  alternates: {
    canonical: "/subscriptions/"
  },
  openGraph: {
    url: "/subscriptions/",
    title: "구독 누적",
    description: "구독 서비스 누적 결제액 계산",
    images: ogImages("subscriptions", "구독 누적")
  },
  twitter: {
    card: "summary_large_image",
    title: "구독 누적",
    description: "구독 서비스 누적 결제액 계산",
    images: ogImages("subscriptions", "구독 누적")
  }
};

export default function SubscriptionPage() {
  return (
    <main className="pageShell">
      <SubscriptionCalculator />
      <AdSlot slot="calculatorBottom" />
      <RelatedCalculators current="/subscriptions/" />
    </main>
  );
}
