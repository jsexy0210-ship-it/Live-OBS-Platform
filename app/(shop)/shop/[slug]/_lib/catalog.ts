import { SHOP_SORTS, type ShopSort } from "../../../../../lib/server/products/shopCatalog";

// 상품 목록 정렬(공개 상품 API와 같은 값). 기본은 파트너스가 정한 목록 기본 정렬(없으면 신상품). 관련도순(relevance)은 검색어(q)가 있을 때만 있고, 검색에서는 기본이다.
export type ListSort = ShopSort | "relevance";
export const SORTS: Record<ListSort, string> = { relevance: "관련도순", recommended: "추천순", popular: "인기순", new: "신상품", low: "낮은 가격", high: "높은 가격" };
// dflt: 파트너스가 정한 목록 기본 정렬(SA-016, 서버 defaultListSort, 미설정은 신상품)
export const sortKey = (v: string | undefined, hasQuery = false, dflt: ShopSort = "new"): ListSort => {
  if (v === "relevance") return hasQuery ? "relevance" : dflt;
  if (SHOP_SORTS.includes(v as ShopSort)) return v as ShopSort;
  return hasQuery ? "relevance" : dflt;
};
export const defaultSort = (hasQuery: boolean, dflt: ShopSort = "new"): ListSort => (hasQuery ? "relevance" : dflt);
export const sortChoices = (hasQuery: boolean) => (Object.keys(SORTS) as ListSort[]).filter((k) => hasQuery || k !== "relevance").map((k) => ({ key: k, label: SORTS[k] }));
export const categoryParam = (v: string | undefined) => (typeof v === "string" ? v : undefined);
