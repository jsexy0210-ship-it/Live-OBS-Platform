"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { UnifiedHome } from "../../../../components/seller/home/UnifiedHome";
import { landingFor, useSeller } from "../../../../components/seller/SellerShell";
import { LoadingRows } from "../../../../components/seller/States";

// /seller: 정지 계정은 기존 정지 안내로, 기능이 있는 계정은 역할별 단일 홈(SA-002)으로 연다.
// 기능이 없으면 기존 권한·요금제상 열 수 있는 첫 메뉴로 보낸다(UX-06·J-2).
// 로그인이 풀려 있으면 공통 틀이 로그인으로 보낸다. 이 주소를 맡는 page는 이 파일 하나뿐이다.
export default function SellerIndex() {
  const { me } = useSeller();
  const router = useRouter();
  const home = !me.suspended && me.features.length > 0;
  useEffect(() => {
    if (me.suspended) router.replace("/seller/suspended");
    else if (!home) router.replace(landingFor(me, "/seller/products"));
  }, [home, me, router]);
  if (home) return <UnifiedHome />;
  return (
    <main className="main" style={{ maxWidth: 480, margin: "80px auto" }}>
      <LoadingRows rows={2} />
    </main>
  );
}
