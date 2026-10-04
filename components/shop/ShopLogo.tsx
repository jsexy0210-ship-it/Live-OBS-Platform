"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

// 구매자 쇼핑몰 머리의 로고(SA-060에서 올린 것). 로고가 없거나 못 받으면 쇼핑몰 이름 첫 글자를 보인다.
// 쇼핑몰 주소(slug)는 화면 경로(/shop/{slug}/...)에서 읽는다.
export default function ShopLogo({ shopName }: { shopName: string }) {
  const slug = (usePathname() ?? "").match(/^\/shop\/([^/]+)/)?.[1];
  const [failed, setFailed] = useState(false);
  const letter = [...shopName.trim()][0] ?? "";
  const box = { width: 28, height: 28, borderRadius: 8, flex: "none" } as const;
  if (!slug || failed) {
    return (
      <span
        aria-hidden="true"
        style={{ ...box, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--brand)", color: "var(--brand-ink)", fontSize: 14, fontWeight: 800 }}
      >
        {letter}
      </span>
    );
  }
  return <img src={`/api/shop/${slug}/shop-content/logo`} alt="" width={28} height={28} style={{ ...box, objectFit: "cover" }} onError={() => setFailed(true)} />;
}
