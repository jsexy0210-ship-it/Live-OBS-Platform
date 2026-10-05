import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductCard } from "../../components/shop/ProductCard";

// 상품 카드 정보(IA ③): 가격 → 혜택(적립) → 신뢰(평점·리뷰 수). 값이 없으면 줄을 그리지 않는다.
const base = { id: "p1", name: "스타라이트 박스", price: 10000, salePrice: null, soldOut: false };
const html = (extra: object) => renderToStaticMarkup(<ProductCard p={{ ...base, ...extra }} />);

describe("ProductCard", () => {
  it("적립·평점·리뷰 수를 가격 다음에 그린다", () => {
    const h = html({ salePrice: 8000, rating: 4.5, reviewCount: 1234, reward: { card: { rate: 1, amount: 80 }, bankTransfer: { rate: 2, amount: 160 } } });
    expect(h).toContain("20%");
    expect(h).toContain("적립 <b>160원</b>"); // 카드·무통장 중 큰 값
    expect(h).toContain("4.5");
    expect(h).toContain("(1,234)");
    expect(h.indexOf("pc-price")).toBeLessThan(h.indexOf("pc-reward"));
    expect(h.indexOf("pc-reward")).toBeLessThan(h.indexOf("pc-rating"));
  });
  it("값이 없거나 0이면 줄이 없다", () => {
    for (const extra of [{}, { rating: null, reviewCount: 0, reward: null }, { rating: 4.8, reviewCount: 0, reward: { card: null, bankTransfer: { rate: 0, amount: 0 } } }]) {
      const h = html(extra);
      expect(h).not.toContain("pc-reward");
      expect(h).not.toContain("pc-rating");
    }
  });
  it("품절 상품은 SOLD OUT 띠가 보인다", () => {
    expect(html({ soldOut: true })).toContain("SOLD OUT");
  });
});
