"use client";

import { useEffect, useState } from "react";
import { ProductGrid, type ProductCardData } from "./ProductCard";
import { call } from "./reviewShared";

// IA ④ 추천 상품: GET /api/shop/{slug}/products/{id}/recommendations?limit=8 (로그인 불필요). 서버가 운영자 지정 → 같은 카테고리 → 전체 순으로 정해 주므로 받은 순서 그대로 보여 준다.
// 하나도 없거나 불러오지 못하면 영역을 그리지 않는다(추천은 구매를 막지 않는다).
export default function RecommendedProducts({ slug, productId }: { slug: string; productId: string }) {
  const [products, setProducts] = useState<ProductCardData[]>([]);
  useEffect(() => {
    let live = true;
    call<{ products: ProductCardData[] }>(`/api/shop/${encodeURIComponent(slug)}/products/${productId}/recommendations?limit=8`).then((r) => {
      if (live && r.ok) setProducts(r.data.products);
    });
    return () => {
      live = false;
    };
  }, [slug, productId]);
  if (products.length === 0) return null;
  return (
    <section className="pd-reco" aria-labelledby="pd-reco-h">
      <h2 id="pd-reco-h">함께 보면 좋아요</h2>
      <ProductGrid products={products} label="추천 상품" hrefBase={`/shop/${encodeURIComponent(slug)}/products`} />
    </section>
  );
}
