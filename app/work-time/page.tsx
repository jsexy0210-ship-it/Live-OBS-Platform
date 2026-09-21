import type { Metadata } from "next";
import { WorkTimeCalculator } from "@/components/WorkTimeCalculator";

export const metadata: Metadata = {
  title: "회사 누적시간 | 인생잔량",
  description: "근무와 출퇴근에 사용한 누적시간 계산"
};

export default function WorkTimePage() {
  return (
    <main className="pageShell">
      <WorkTimeCalculator />
    </main>
  );
}
