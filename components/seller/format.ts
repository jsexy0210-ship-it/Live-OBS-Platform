import type { Product, ProductStatus } from "./api";

export const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

// 서버와 같은 기준(NFKC 정규화 뒤 앞뒤 공백 제외)으로 글자 수를 센다
export const textLength = (v: string) => v.normalize("NFKC").trim().length;

export const INT4_MAX = 2147483647;
export const LOW_STOCK = 3;

export const STATUS_LABEL: Record<ProductStatus, string> = { ON_SALE: "판매 중", SOLD_OUT: "품절", HIDDEN: "숨김", DRAFT: "임시 저장" };

export const totalStock = (p: Product) => p.options.reduce((s, o) => s + o.stock, 0);

// 목록 배지: 판매 중인데 재고가 적거나 없으면 그 상태를 먼저 보여 준다
export function statusBadge(p: Product): { label: string; cls: string } {
  if (p.status === "ON_SALE") {
    const stock = totalStock(p);
    if (stock === 0) return { label: "품절", cls: "b-fail" };
    if (stock <= LOW_STOCK) return { label: "재고 부족", cls: "b-warn" };
    return { label: "판매 중", cls: "b-done" };
  }
  if (p.status === "SOLD_OUT") return { label: "품절", cls: "b-fail" };
  if (p.status === "HIDDEN") return { label: "숨김", cls: "b-gray nodot" };
  return { label: "임시 저장", cls: "b-wait nodot" };
}

// 「12,000」「12000원」처럼 써도 숫자만 읽는다. 숫자가 아니면 null
export function parseAmount(v: string, allowNegative = false): number | null {
  const t = v.replace(/[,\s원]/g, "");
  if (!(allowNegative ? /^-?\d+$/ : /^\d+$/).test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}
