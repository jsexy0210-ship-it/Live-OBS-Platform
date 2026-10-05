"use client";

import { useSmartBack } from "../../lib/client/navigation";

// J-1 상세 화면 공통 ← 버튼. 앱 안 이전 화면이 있으면 그리로, 없으면(직접 진입) 부모 화면으로 간다.
export default function ShopBack({ fallback, label = "이전" }: { fallback: string; label?: string }) {
  const back = useSmartBack(fallback);
  return (
    <button type="button" className="shop-back" onClick={back} aria-label={`${label} 화면으로`}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 5l-7 7 7 7" />
      </svg>
      {label}
    </button>
  );
}
