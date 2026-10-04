// 구매자 쇼핑몰 상품 카드·격자(SH-001 홈·SH-002 목록). 격자는 PC 4열·태블릿 3열·휴대폰 2열(styles/shop.css .pc-grid).
// 상품 사진은 구매자에게 사진을 내주는 API가 생기기 전까지 빈 사진 칸으로 둔다. 상품 상세 화면이 생기면 카드에 링크를 단다.
export type ProductCardData = { id: string; name: string; price: number; salePrice: number | null; soldOut: boolean };

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export function ProductCard({ p }: { p: ProductCardData }) {
  const rate = p.salePrice !== null ? Math.floor(((p.price - p.salePrice) / p.price) * 100) : 0;
  return (
    <li className={`pc${p.soldOut ? " is-out" : ""}`}>
      <div className="pc-photo" aria-hidden="true" />
      {p.soldOut && <span className="pc-out">품절</span>}
      <p className="pc-name">{p.name}</p>
      <p className="pc-price">
        {p.salePrice !== null ? (
          <>
            {rate > 0 && <span className="pc-rate">{rate}%</span>}
            <strong>{won(p.salePrice)}</strong>
            <del>{won(p.price)}</del>
          </>
        ) : (
          <strong>{won(p.price)}</strong>
        )}
      </p>
    </li>
  );
}

export function ProductGrid({ products, label }: { products: ProductCardData[]; label: string }) {
  return (
    <ul className="pc-grid" aria-label={label}>
      {products.map((p) => (
        <ProductCard key={p.id} p={p} />
      ))}
    </ul>
  );
}
