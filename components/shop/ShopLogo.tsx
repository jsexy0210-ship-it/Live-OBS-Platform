"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// 구매자 쇼핑몰 머리의 로고(SA-060에서 올린 것). 로고가 없거나 못 받으면 쇼핑몰 이름 첫 글자를 보인다.
// 쇼핑몰 주소(slug)는 화면 경로(/shop/{slug}/...)에서 읽는다.
export default function ShopLogo({ shopName }: { shopName: string }) {
  const slug = (usePathname() ?? "").match(/^\/shop\/([^/]+)/)?.[1];
  const [failed, setFailed] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // 화면이 준비되기 전에 이미 실패한 이미지는 onError가 다시 오지 않으므로 붙은 뒤 한 번 확인한다
  useEffect(() => {
    const el = img.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, []);
  const letter = [...shopName.trim()][0] ?? "";
  const box = { width: 28, height: 28, borderRadius: 8, flex: "none" } as const;
  if (!slug || failed) {
    return (
      <span
        aria-hidden="true"
        style={{ ...box, display: "inline-flex", alignItems: "center", justifyContent: "center", background: "var(--wds-primary-normal)", color: "#ffffff", fontSize: 14, fontWeight: 800 }}
      >
        {letter}
      </span>
    );
  }
  return <img ref={img} src={`/api/shop/${slug}/shop-content/logo`} alt="" width={28} height={28} style={{ ...box, objectFit: "cover" }} onError={() => setFailed(true)} />;
}
