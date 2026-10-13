import Image from "next/image";
import type { CSSProperties } from "react";
import symbol from "../../public/branding/streamshop-symbol.png";

// 승인 심볼 원본과 점 없는 워드마크를 공개 화면에서 함께 쓴다.
export function StreamShopBrand({ className, style, width = 36, height = 40 }: { className?: string; style?: CSSProperties; width?: number; height?: number }) {
  return <span className={`streamshop-brand ${className ?? ""}`} style={style} aria-label="스트림샵">
    <Image src={symbol} alt="" width={width} height={height} sizes={`${width}px`} />
    <span>streamshop</span>
  </span>;
}
