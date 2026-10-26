import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HomeProducts from "../../components/shop/HomeProducts";

const product = { id: "00000000-0000-4000-8000-000000000001", name: "소유 상품", price: 10000, salePrice: 8000, soldOut: false };
const render = (soldOut = false) => renderToStaticMarkup(<HomeProducts slug="owned-shop" loggedIn={false} live={false} sections={[{ kind: "LIVE", title: "방송 중 상품", products: [{ ...product, soldOut }] }]} />);

describe("쇼핑몰 홈의 기존 상품 카드 동작 진입", () => {
  it("상품 가격·상세·최근 방송 안내를 유지하며 찜과 담기를 제공한다", () => {
    const html = render();
    expect(html).toContain("최근 방송 상품");
    expect(html).toContain("8,000원");
    expect(html).toContain(`/shop/owned-shop/products/${product.id}`);
    expect(html).toContain('aria-label="찜" aria-pressed="false"');
    expect(html).toContain('class="btn btn-sm btn-out home-card-cart" type="button">담기</button>');
  });
  it("품절 상품은 담기만 잠그고 기존 찜 진입과 품절 표시를 유지한다", () => {
    const html = render(true);
    expect(html).toContain('aria-label="품절"');
    expect(html).toContain('class="btn btn-sm btn-out home-card-cart" type="button" disabled="">담기</button>');
    expect(html).toContain('aria-label="찜" aria-pressed="false">');
  });
});
