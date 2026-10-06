"use client";

import "../../../../../styles/seller-overlay.css";
import { PageHead } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { NoPermission } from "../../../../../components/seller/States";
import OverlayEditor from "../../../../../components/seller/OverlayEditor";

// SA-051 방송 화면 꾸미기(첫 탭 「편집기」). 머리 오른쪽의 되돌리기·저장 같은 버튼은 편집 상태를 쥔 OverlayEditor가 PageHead에 그린다.
// 방송 프로그램에 넣는 주소 발급·재발급(SA-052)은 둘째 탭 /seller/overlay/address.
export default function OverlayPage() {
  const { can } = useSeller();
  const allowed = can("OVERLAY_EDIT");
  return (
    <>
      <Topbar crumb="방송 › 방송 화면 꾸미기" />
      <main className="main">
        {allowed ? (
          <OverlayEditor />
        ) : (
          <>
            <PageHead title="방송 화면 꾸미기" />
            <div className="card">
              <NoPermission need="오버레이 편집" />
            </div>
          </>
        )}
      </main>
    </>
  );
}
