"use client";

import { useEffect, useRef, useState } from "react";

// 이미지 실패는 사진 칸의 기존 대체 그림으로 돌아간다. SSR 뒤 이미 실패한 경우도 확인한다.
export default function ProductImage({ src, name }: { src?: string | null; name: string }) {
  const image = useRef<HTMLImageElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = image.current;
    if (el && el.complete && el.naturalWidth === 0) setFailed(true);
  }, []);
  return src && !failed
    ? <img ref={image} src={src} alt={name} loading="lazy" onError={() => setFailed(true)} />
    : <span role="img" aria-label={name + " 상품 이미지 없음"} style={{ position: "absolute", inset: 0 }} />;
}
