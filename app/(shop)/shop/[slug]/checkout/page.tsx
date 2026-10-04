import type { Metadata } from "next";
import ComingSoon from "../_lib/ComingSoon";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "주문서" };

// SH-005 주문서: 장바구니의 「주문하기」가 여기로 온다(?ids=). 주문서 화면이 생기면 /cart/checkout?ids= 응답으로 채운다.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <ComingSoon slug={(await params).slug} title="주문서는 준비 중이에요" body="곧 이 화면에서 배송지를 정하고 주문할 수 있어요." />;
}
