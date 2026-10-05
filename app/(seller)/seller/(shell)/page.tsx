"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { HomeDashboard } from "../../../../components/seller/home/HomeDashboard";
import { landingFor, useSeller } from "../../../../components/seller/SellerShell";
import { LoadingRows } from "../../../../components/seller/States";

// /seller: 이용 정지 중이면 정지 안내(AU-006)로 보낸다. 쇼핑몰 통합 요금제는 파트너스 홈(SA-002)을 보여 주고,
// 오버레이 전용은 오버레이 홈(SA-002-O)으로, 그 밖은 권한·요금제상 열 수 있는 첫 메뉴로 보낸다(UX-06·J-2).
// 로그인이 풀려 있으면 공통 틀이 로그인으로 보낸다. 이 주소를 맡는 page는 이 파일 하나뿐이다.
export default function SellerIndex() {
  const { me } = useSeller();
  const router = useRouter();
  const home = !me.suspended && me.features.includes("STORE_OPERATIONS");
  useEffect(() => {
    if (me.suspended) router.replace("/seller/suspended");
    else if (!home) router.replace(me.features.includes("OVERLAY") ? "/seller/home-overlay" : landingFor(me, "/seller/products"));
  }, [home, me, router]);
  if (home) return <HomeDashboard />;
  return (
    <main className="main" style={{ maxWidth: 480, margin: "80px auto" }}>
      <LoadingRows rows={2} />
    </main>
  );
}
