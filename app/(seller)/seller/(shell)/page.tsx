"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { HomeDashboard } from "../../../../components/seller/home/HomeDashboard";
import { landingFor, useSeller } from "../../../../components/seller/SellerShell";
import { LoadingRows } from "../../../../components/seller/States";

// /seller: 쇼핑몰 통합 요금제는 파트너스 홈(SA-002)을 보여 준다. 그 밖(오버레이 전용 홈 SA-002-O를 만들기 전)은
// 권한·요금제상 열 수 있는 첫 메뉴로 보낸다(UX-06·J-2). 로그인이 풀려 있으면 공통 틀이 로그인으로 보낸다.
export default function SellerIndex() {
  const { me } = useSeller();
  const router = useRouter();
  const home = me.features.includes("STORE_OPERATIONS");
  useEffect(() => {
    if (!home) router.replace(landingFor(me, "/seller/products"));
  }, [home, me, router]);
  if (home) return <HomeDashboard />;
  return (
    <main className="main" style={{ maxWidth: 480, margin: "80px auto" }}>
      <LoadingRows rows={2} />
    </main>
  );
}
