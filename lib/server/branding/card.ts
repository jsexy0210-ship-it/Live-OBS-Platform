import { renderShopOgCard } from "../shop/ogCard";

// 제목으로 그리는 공유 카드(1200×630 PNG). 쇼핑몰 기본 카드(shop/ogCard.ts)와 같은 그리기(원티드 산스 + next/og)를 그대로 쓴다:
// 제목을 크게, 아래에 ONQ. 같은 제목은 최근 것만 메모리에 들고 있다(공개 주소라 매번 그리지 않게).
const CACHE_MAX = 20;
const rendered = new Map<string, Promise<Buffer>>();

export function renderBrandingCard(title: string): Promise<Buffer> {
  let png = rendered.get(title);
  if (!png) {
    png = renderShopOgCard(title);
    png.catch(() => rendered.delete(title));
    rendered.set(title, png);
    if (rendered.size > CACHE_MAX) rendered.delete(rendered.keys().next().value!);
  }
  return png;
}
