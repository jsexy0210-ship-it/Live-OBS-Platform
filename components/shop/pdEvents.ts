// 상품 상세 탭의 숫자(리뷰 n·상품 문의 n): 영역이 불러온 개수를 알려 주면 탭이 따라간다.
export const PD_COUNT_EVENT = "shop-pd-count";
export type PdCount = { key: "reviews" | "inquiries"; n: number };
export const announceCount = (c: PdCount) => window.dispatchEvent(new CustomEvent<PdCount>(PD_COUNT_EVENT, { detail: c }));
