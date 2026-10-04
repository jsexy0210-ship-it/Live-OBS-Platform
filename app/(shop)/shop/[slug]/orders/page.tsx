import type { Metadata } from "next";
import ComingSoon from "../_lib/ComingSoon";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "주문 조회" };

// SH-021 주문 조회: 주문 내역 화면을 만들면 바꾼다(회원 주문 목록 API는 있음).
export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  return <ComingSoon slug={(await params).slug} title="주문 조회는 준비 중이에요" body="곧 여기에서 주문 내역과 배송 상태를 볼 수 있어요." />;
}
