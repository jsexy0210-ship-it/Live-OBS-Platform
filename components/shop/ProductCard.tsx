import Link from "next/link";
// 구매자 쇼핑몰 상품 카드·격자(SH-001 홈·SH-002 목록). 격자는 PC 4열·태블릿 3열·휴대폰 2열(styles/shop.css .pc-grid).
// 사진(thumbnailUrl)이 없는 상품은 빈 사진 칸으로 둔다.
export type ProductCardData = { id: string; name: string; price: number; salePrice: number | null; soldOut: boolean; thumbnailUrl?: string | null };

// 링크가 있으면 사진·이름이 상품 상세로 이어진다
function Wrap({ href, className, children }: { href?: string; className: string; children: React.ReactNode }) {
  return href ? (
    <Link href={href} className={className}>
      {children}
    </Link>
  ) : (
    <div className={className}>{children}</div>
  );
}

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

export function ProductCard({ p, href, children }: { p: ProductCardData; href?: string; children?: React.ReactNode }) {
  const rate = p.salePrice !== null ? Math.floor(((p.price - p.salePrice) / p.price) * 100) : 0;
  return (
    <li className="pc">
      <Wrap href={href} className="pc-photo">
        {p.thumbnailUrl && <img src={p.thumbnailUrl} alt="" loading="lazy" />}
        {p.soldOut && <span className="pc-out" role="img" aria-label="품절">SOLD OUT</span>}
      </Wrap>
      <Wrap href={href} className="pc-name">
        {p.name}
      </Wrap>
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
      {children}
    </li>
  );
}

export function ProductGrid({ products, label, hrefBase }: { products: ProductCardData[]; label: string; hrefBase?: string }) {
  return (
    <ul className="pc-grid" aria-label={label}>
      {products.map((p) => (
        <ProductCard key={p.id} p={p} href={hrefBase ? `${hrefBase}/${p.id}` : undefined} />
      ))}
    </ul>
  );
}
