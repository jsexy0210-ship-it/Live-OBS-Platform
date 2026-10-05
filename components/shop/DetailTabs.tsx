"use client";

import { useEffect, useState } from "react";
import { PD_COUNT_EVENT, type PdCount } from "./pdEvents";

// 상품 상세 탭(보드 SH-003-IA): 상세 정보 · 리뷰 n · 상품 문의 n. 누르면 그 영역으로 이동한다(한 화면에 모두 있음).
export default function DetailTabs() {
  const [n, setN] = useState<{ reviews?: number; inquiries?: number }>({});
  useEffect(() => {
    const on = (e: Event) => {
      const c = (e as CustomEvent<PdCount>).detail;
      setN((p) => ({ ...p, [c.key]: c.n }));
    };
    window.addEventListener(PD_COUNT_EVENT, on);
    return () => window.removeEventListener(PD_COUNT_EVENT, on);
  }, []);
  const tab = (id: string, label: string, count?: number) => (
    <a key={id} href={`#${id}`}>
      {label}
      {count !== undefined && <span className="pd-tabs-c"> {count.toLocaleString("ko-KR")}</span>}
    </a>
  );
  return (
    <nav className="pd-tabs" aria-label="상품 상세 메뉴">
      {tab("pd-info", "상세 정보")}
      {tab("pd-reviews", "리뷰", n.reviews)}
      {tab("pd-qna", "상품 문의", n.inquiries)}
    </nav>
  );
}
