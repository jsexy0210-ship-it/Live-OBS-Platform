import { redirect } from "next/navigation";

// 통계 첫 화면은 주문 통계로 보낸다
export default function StatsIndex() {
  redirect("/seller/stats/orders");
}
