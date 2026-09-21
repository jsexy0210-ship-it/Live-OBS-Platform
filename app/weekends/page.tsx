import type { Metadata } from "next";
import { WeekendCalculator } from "@/components/WeekendCalculator";

export const metadata: Metadata = {
  title: "주말 잔량 | 인생잔량",
  description: "선택한 기준 나이까지 남은 주말 횟수 계산"
};

export default function WeekendsPage() {
  return (
    <main className="pageShell">
      <WeekendCalculator />
    </main>
  );
}
