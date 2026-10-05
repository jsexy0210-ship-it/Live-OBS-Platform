"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorState, LoadingRows } from "../../../components/seller/States";
import { landingFor } from "../../../components/seller/SellerShell";
import { api, type Me } from "../../../components/seller/api";

// 파트너스 홈(SA-002)을 만들기 전까지 /seller는 권한·요금제상 열 수 있는 첫 메뉴로 보낸다(UX-06·J-2).
// 로그인이 풀려 있으면 api가 로그인으로 보낸다. 홈이 생기면 이 화면을 홈으로 바꾼다.
export default function SellerIndex() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const [try_, setTry] = useState(0);

  useEffect(() => {
    let live = true;
    void api<Me>("/api/seller/me").then((r) => {
      if (!live) return;
      if (r.ok) router.replace(!r.data.features.includes("STORE_OPERATIONS") && r.data.features.includes("OVERLAY") ? "/seller/home-overlay" : landingFor(r.data, "/seller/products"));
      else setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [router, try_]);

  return (
    <main className="main" style={{ maxWidth: 480, margin: "80px auto" }}>
      {failed ? <ErrorState title="화면을 불러오지 못했습니다" onRetry={() => (setFailed(false), setTry((n) => n + 1))} /> : <LoadingRows rows={2} />}
    </main>
  );
}
