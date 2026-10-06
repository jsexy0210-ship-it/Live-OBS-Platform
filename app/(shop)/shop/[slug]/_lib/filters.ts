import type { PublicCategory } from "../../../../../lib/server/shop-category/service";

// SH-002 필터(보드 SH-002-F · SH-002-PC-IA 「검색 조건」): 분류(게임·형태 등 대분류마다 하위 하나, cats=쉼표) · 재고 있는 상품만(inStock=1) · 방송 중 상품만(live=1) · 가격(minPrice·maxPrice).
// 주소의 값을 그대로 믿지 않고 여기서 거른다(없는 분류·이상한 가격은 버려 서버가 400·404를 내지 않게 한다).
export type Filters = { cats: string[]; inStock: boolean; live: boolean; min: string; max: string };
export const FILTER_KEYS = ["cats", "inStock", "live", "minPrice", "maxPrice"] as const;
const PRICE_MAX = 100_000_000;
const price = (v: unknown) => (typeof v === "string" && /^\d{1,9}$/.test(v) && Number(v) <= PRICE_MAX ? String(Number(v)) : "");

export function parseFilters(sp: { cats?: string; inStock?: string; live?: string; minPrice?: string; maxPrice?: string }, tree: PublicCategory[]): Filters {
  const known = new Set(tree.flatMap((c) => c.children.map((x) => x.id)));
  const cats = [...new Set((typeof sp.cats === "string" ? sp.cats.split(",") : []).filter((id) => known.has(id)))].slice(0, 4);
  let min = price(sp.minPrice);
  let max = price(sp.maxPrice);
  if (min && max && Number(min) > Number(max)) min = max = ""; // 최대가 최소보다 작으면 가격 조건을 버린다
  return { cats, inStock: sp.inStock === "1", live: sp.live === "1", min, max };
}

export const filterCount = (f: Filters) => f.cats.length + (f.inStock ? 1 : 0) + (f.live ? 1 : 0) + (f.min || f.max ? 1 : 0);

// 목록 조회(공개 상품 API와 같은 이름)와 주소가 같은 이름을 쓴다.
export function filterParams(f: Filters, into: URLSearchParams = new URLSearchParams()) {
  if (f.cats.length) into.set("cats", f.cats.join(","));
  if (f.inStock) into.set("inStock", "1");
  if (f.live) into.set("live", "1");
  if (f.min) into.set("minPrice", f.min);
  if (f.max) into.set("maxPrice", f.max);
  return into;
}

export const priceLabel = (f: Filters) => {
  const w = (n: string) => `${Number(n).toLocaleString("ko-KR")}원`;
  return f.min && f.max ? `${w(f.min)} ~ ${w(f.max)}` : f.min ? `${w(f.min)} 이상` : `${w(f.max)} 이하`;
};
