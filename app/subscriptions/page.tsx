import type { Metadata } from "next";
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
    description: "구독 서비스 누적 결제액 계산"
  }
};

export default function SubscriptionPage() {
  return (
    <main className="pageShell">
      <SubscriptionCalculator />
    </main>
  );
}
