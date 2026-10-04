import type { Metadata } from "next";
import { OverlayView } from "../../../components/overlay/OverlayView";

// OV-001(세로 9:16, 1080×1920) · OV-002(가로 16:9, 1920×1080) 기본 오버레이. OBS 「브라우저 소스」에 이 주소를 넣는다.
// 가로형은 ?ratio=16x9. 주소의 토큰이 판매자를 정한다(SA-052에서 발급·재발급, 재발급하면 옛 주소는 바로 끊김).
export const metadata: Metadata = {
  title: "오버레이",
  robots: { index: false, follow: false },
  // 주소에 든 토큰이 다른 곳으로 새지 않게
  referrer: "no-referrer",
};

export default async function OverlayPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ ratio?: string }> }) {
  const { token } = await params;
  const { ratio } = await searchParams;
  return <OverlayView token={token} landscape={ratio === "16x9"} />;
}
