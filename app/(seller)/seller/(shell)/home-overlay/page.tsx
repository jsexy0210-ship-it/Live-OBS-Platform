"use client";

import { OverlayHome } from "../../../../../components/seller/home/OverlayHome";
import { Topbar } from "../../../../../components/seller/SellerShell";

// SA-002-O 오버레이 전용 홈(메뉴 「홈」). 화면은 components/seller/home/OverlayHome.tsx.
export default function OverlayHomePage() {
  return (
    <>
      <Topbar crumb="홈" />
      <OverlayHome />
    </>
  );
}
