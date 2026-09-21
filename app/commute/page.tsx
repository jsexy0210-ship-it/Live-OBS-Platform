import type { Metadata } from "next";
import { CommuteCalculator } from "@/components/CommuteCalculator";

export const metadata: Metadata = {
  title: "출근 잔량 | 인생잔량",
  description: "예상 은퇴까지 남은 출근 횟수 계산"
};

export default function CommutePage() {
  return (
    <main className="pageShell">
      <CommuteCalculator />
    </main>
  );
}
