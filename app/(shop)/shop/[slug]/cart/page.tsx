import type { Metadata } from "next";
import ComingSoon from "../_lib/ComingSoon";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "장바구니" };

// SH-004 장바구니: 장바구니 기능(API)이 생기면 표 형태 목록과 단계 표시(장바구니 → 주문서 → 완료)로 바꾼다.
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <ComingSoon slug={(await params).slug} title="장바구니는 준비 중이에요" body="곧 상품을 담아 한 번에 주문할 수 있어요." />;
}
