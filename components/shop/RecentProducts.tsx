"use client";

import { useEffect, useMemo, useState } from "react";
import { ProductGrid, type ProductCardData } from "./ProductCard";

// 최근 본 상품(보드 SH-003-IA): 이 기기에서 본 상품을 localStorage에 최근 순 10개까지 남기고(서버 값 없음, 로그인 무관), 지금 보는 상품은 빼고 보여 준다.
const key = (slug: string) => `shop-recent-products:${slug}`;
const MAX = 10;

export function readRecent(slug: string): ProductCardData[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(key(slug)) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as ProductCardData[]).filter((x) => x && typeof x.id === "string" && typeof x.name === "string") : [];
  } catch {
    return [];
  }
}

export default function RecentProducts({ slug, current }: { slug: string; current: ProductCardData }) {
  const [others, setOthers] = useState<ProductCardData[]>([]);
  // 값이 같으면 같은 객체로 두어 효과가 불필요하게 다시 돌지 않게 한다
  const { id, name, price, salePrice, soldOut, thumbnailUrl } = current;
  const card = useMemo<ProductCardData>(() => ({ id, name, price, salePrice, soldOut, thumbnailUrl }), [id, name, price, salePrice, soldOut, thumbnailUrl]);
  useEffect(() => {
    const prev = readRecent(slug);
    const next = [card, ...prev.filter((x) => x.id !== card.id)].slice(0, MAX);
    try {
      window.localStorage.setItem(key(slug), JSON.stringify(next));
    } catch {
      // 저장하지 못해도 이번 화면에서는 보여 준다
    }
    setOthers(prev.filter((x) => x.id !== card.id).slice(0, 6));
  }, [slug, card]);
  if (others.length === 0) return null;
  return (
    <section className="pd-reco" aria-labelledby="pd-recent-h">
      <h2 id="pd-recent-h">최근 본 상품</h2>
      <ProductGrid products={others} label="최근 본 상품" hrefBase={`/shop/${encodeURIComponent(slug)}/products`} />
    </section>
  );
}
