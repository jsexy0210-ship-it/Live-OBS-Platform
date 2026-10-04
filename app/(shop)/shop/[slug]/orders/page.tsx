import type { Metadata } from "next";
import { redirect } from "next/navigation";
import ComingSoon from "../_lib/ComingSoon";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "주문 조회" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SH-021 주문 조회: 주문 내역 화면을 만들면 바꾼다(회원 주문 목록 API는 있음).
// 결제 창이 끝나면 서버가 ?orderId=…&payment=…로 보내므로, 그 주문의 상세 화면으로 넘긴다.
export default async function Page({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ orderId?: string; payment?: string }> }) {
  const { slug } = await params;
  const { orderId, payment } = await searchParams;
  if (typeof orderId === "string" && UUID.test(orderId)) {
    const q = typeof payment === "string" && /^[a-z]{1,20}$/.test(payment) ? `?payment=${payment}` : "";
    redirect(`/shop/${encodeURIComponent(slug)}/orders/${orderId}${q}`);
  }
  return <ComingSoon slug={slug} title="주문 조회는 준비 중이에요" body="곧 여기에서 주문 내역과 배송 상태를 볼 수 있어요." />;
}
