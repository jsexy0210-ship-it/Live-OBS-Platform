import type { Metadata } from "next";
import { SalaryCalculator } from "@/components/SalaryCalculator";

export const metadata: Metadata = {
  title: "월급 잔량",
  description: "예상 은퇴까지 남은 월급 횟수 계산",
  alternates: {
    canonical: "/salary/"
  },
  openGraph: {
    url: "/salary/",
    title: "월급 잔량",
    description: "예상 은퇴까지 남은 월급 횟수 계산"
  }
};

export default function SalaryPage() {
  return (
    <main className="pageShell">
      <SalaryCalculator />
    </main>
  );
}
