"use client";

import { useEffect, useState } from "react";
import { ProductGrid, type ProductCardData } from "./ProductCard";

// 최근 본 상품(보드 SH-003-IA): 이 기기에서 본 상품을 localStorage에 최근 순 10개까지 남기고(서버 값 없음, 로그인 무관), 지금 보는 상품은 빼고 보여 준다.
const key = (slug: string) => `shop-recent-products:${slug}`;
const MAX = 10;

function read(slug: string): ProductCardData[] {
  try {
    const v = JSON.parse(window.localStorage.getItem(key(slug)) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as ProductCardData[]).filter((x) => x && typeof x.id === "string" && typeof x.name === "string") : [];
  } catch {
    return [];
  }
}

export default function RecentProducts({ slug, current }: { slug: string; current: ProductCardData }) {
  const [others, setOthers] = useState<ProductCardData[]>([]);
  useEffect(() => {
    const prev = read(slug);
    const next = [current, ...prev.filter((x) => x.id !== current.id)].slice(0, MAX);
    try {
      window.localStorage.setItem(key(slug), JSON.stringify(next));
    } catch {
      // 저장하지 못해도 이번 화면에서는 보여 준다
    }
    setOthers(prev.filter((x) => x.id !== current.id).slice(0, 6));
    // 지금 상품이 바뀔 때만 다시 기록한다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug, current.id]);
  if (others.length === 0) return null;
  return (
    <section className="pd-reco" aria-labelledby="pd-recent-h">
      <h2 id="pd-recent-h">최근 본 상품</h2>
      <ProductGrid products={others} label="최근 본 상품" hrefBase={`/shop/${encodeURIComponent(slug)}/products`} />
    </section>
  );
}
