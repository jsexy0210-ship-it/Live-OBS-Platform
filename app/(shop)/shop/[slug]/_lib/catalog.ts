import { SHOP_SORTS, type ShopSort } from "../../../../../lib/server/products/shopCatalog";

// 상품 목록 정렬(공개 상품 API와 같은 값). 기본은 신상품.
export const SORTS: Record<ShopSort, string> = { recommended: "추천순", popular: "인기순", new: "신상품", low: "낮은 가격", high: "높은 가격" };
export const sortKey = (v: string | undefined): ShopSort => (SHOP_SORTS.includes(v as ShopSort) ? (v as ShopSort) : "new");
export const categoryParam = (v: string | undefined) => (typeof v === "string" ? v : undefined);
