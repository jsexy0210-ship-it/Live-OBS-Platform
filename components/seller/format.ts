import type { Product, ProductStatus } from "./api";

export const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

// 글자 수는 서버와 같은 공용 함수로 센다(NFKC 정규화·앞뒤 공백 제외·코드포인트 기준, 이모지 하나 = 1자)
export { textLength } from "../../lib/server/text/clean";
// 상품 이름 검색어 최대 길이(NFKC 뒤 코드포인트). 서버 lib/server/products/manage.ts MAX_SEARCH_LENGTH와 같은 값
export const MAX_SEARCH_LENGTH = 50;

export const INT4_MAX = 2147483647;
// 서버 「재고 부족」 기준(LOW_STOCK_MAX = 5)과 같게 둔다
export const LOW_STOCK = 5;

export const STATUS_LABEL: Record<ProductStatus, string> = { ON_SALE: "판매 중", SOLD_OUT: "품절", HIDDEN: "숨김", DRAFT: "임시 저장" };

export const totalStock = (p: Product) => p.options.reduce((s, o) => s + o.stock, 0);

// 목록 배지: 판매 중인데 재고가 적거나 없으면 그 상태를 먼저 보여 준다
export function statusBadge(p: Product): { label: string; cls: string } {
  if (p.status === "ON_SALE") {
    const stock = totalStock(p);
    // 판매 상태는 「판매 중」인데 재고가 다 떨어진 것. 판매자가 「품절」로 설정한 상품과 구분한다
    if (stock === 0) return { label: "재고 없음", cls: "b-fail" };
    if (stock <= LOW_STOCK) return { label: "재고 부족", cls: "b-warn" };
    return { label: "판매 중", cls: "b-done" };
  }
  if (p.status === "SOLD_OUT") return { label: "품절", cls: "b-fail" };
  if (p.status === "HIDDEN") return { label: "숨김", cls: "b-gray nodot" };
  return { label: "임시 저장", cls: "b-wait nodot" };
}

// 「12,000」「12000원」「１２０００」(전각)「+10」처럼 써도 정수로 읽는다. 음수도 읽고 범위는 부르는 쪽이 검사한다. 숫자가 아니면 null
export function parseAmount(v: string): number | null {
  const t = v.normalize("NFKC").replace(/[,\s원]/g, "").replace(/^[−–]/, "-");
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}
