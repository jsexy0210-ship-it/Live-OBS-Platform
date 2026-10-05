import { ImageResponse } from "next/og";
import { createElement as h } from "react";

// 파비콘 크기별 PNG 그리기(SA-060). 원본 PNG를 가운데에 맞춰(비율 유지) 정사각형 투명 바탕에 그린다. 새 의존성 없이 공유 카드와 같은 next/og를 쓴다.
// inset: 가장자리 여백 비율(로고에서 자동으로 만들 때 0.1, 올린 파비콘은 0). 같은 입력은 메모리에 최근 것만 들고 있다(공개 주소라 매번 그리지 않게).
export const FAVICON_SIZES = [32, 180, 512] as const;
export type FaviconSize = (typeof FAVICON_SIZES)[number];
export const isFaviconSize = (n: number): n is FaviconSize => (FAVICON_SIZES as readonly number[]).includes(n);

const CACHE_MAX = 300;
const rendered = new Map<string, Promise<Buffer>>();

export function renderFaviconPng(key: string, source: Uint8Array, side: FaviconSize, inset: number): Promise<Buffer> {
  const k = `${key}:${side}:${inset}`;
  let png = rendered.get(k);
  if (!png) {
    const inner = Math.round(side * (1 - inset * 2));
    const url = `data:image/png;base64,${Buffer.from(source).toString("base64")}`;
    png = (async () => {
      const res = new ImageResponse(h("div", { style: { display: "flex", width: side, height: side, alignItems: "center", justifyContent: "center" } }, h("img", { src: url, width: inner, height: inner })), { width: side, height: side });
      return Buffer.from(await res.arrayBuffer());
    })();
    png.catch(() => rendered.delete(k));
    rendered.set(k, png);
    if (rendered.size > CACHE_MAX) rendered.delete(rendered.keys().next().value!);
  }
  return png;
}
