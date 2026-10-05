import type { Metadata } from "next";
import { redirect } from "next/navigation";
import OrdersView from "../../../../../components/shop/OrdersView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "주문 내역" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SH-021 주문 내역: 본인 주문 목록(OrdersView). 기존 주문 조회는 잠긴 쇼핑몰에서도 열린다(API와 같은 기준).
// 결제 창이 끝나면 서버가 ?orderId=…&payment=…로 보내므로, 그 주문의 상세 화면으로 넘긴다.
export default async function Page({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ orderId?: string; payment?: string }> }) {
  const { slug } = await params;
  const { orderId, payment } = await searchParams;
  if (typeof orderId === "string" && UUID.test(orderId)) {
    const q = typeof payment === "string" && /^[a-z]{1,20}$/.test(payment) ? `?payment=${payment}` : "";
    redirect(`/shop/${encodeURIComponent(slug)}/orders/${orderId}${q}`);
  }
  return <OrdersView slug={slug} />;
}
