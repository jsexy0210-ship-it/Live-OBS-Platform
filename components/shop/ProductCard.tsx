import Link from "next/link";
// 구매자 쇼핑몰 상품 카드·격자(SH-001 홈·SH-002 목록). 격자는 PC 4열·태블릿 3열·휴대폰 2열(styles/shop.css .pc-grid).
// 사진(thumbnailUrl)이 없는 상품은 빈 사진 칸으로 둔다.
export type ProductCardData = {
  id: string;
  name: string;
  price: number;
  salePrice: number | null;
  soldOut: boolean;
  thumbnailUrl?: string | null;
  isLive?: boolean; // 지금 방송에서 주문된 상품
  // 평점·리뷰 수·예상 적립(상품 목록·홈 API가 주는 값. 없으면 그 줄을 그리지 않는다)
  rating?: number | null;
  reviewCount?: number;
  reward?: { card: { rate: number; amount: number } | null; bankTransfer: { rate: number; amount: number } | null } | null;
};

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
  const reward = Math.max(p.reward?.card?.amount ?? 0, p.reward?.bankTransfer?.amount ?? 0); // 카드·무통장 중 큰 값
  return (
    <li className="pc">
      <Wrap href={href} className="pc-photo">
        {p.thumbnailUrl && <img src={p.thumbnailUrl} alt="" loading="lazy" />}
        {p.isLive && <span className="pc-live">LIVE</span>}
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
      {reward > 0 && (
        <p className="pc-reward">
          적립 <b>{won(reward)}</b>
        </p>
      )}
      {(p.reviewCount ?? 0) > 0 && p.rating != null && (
        <p className="pc-rating" aria-label={`평점 ${p.rating.toFixed(1)}점, 리뷰 ${p.reviewCount}개`}>
          <span aria-hidden="true">★</span> {p.rating.toFixed(1)} <span className="pc-rc">({(p.reviewCount ?? 0).toLocaleString("ko-KR")})</span>
        </p>
      )}
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
