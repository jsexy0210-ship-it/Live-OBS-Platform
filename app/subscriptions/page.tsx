import type { Metadata } from "next";
import { SubscriptionCalculator } from "@/components/SubscriptionCalculator";

export const metadata: Metadata = {
  title: "구독 누적 | 인생잔량",
  description: "구독 서비스 누적 결제액 계산"
};

export default function SubscriptionsPage() {
  return (
    <main className="pageShell">
      <SubscriptionCalculator />
    </main>
  );
}
