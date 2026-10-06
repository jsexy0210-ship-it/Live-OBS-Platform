import Link from "next/link";
import { ProductGrid } from "../../../../../components/shop/ProductCard";
import { prisma } from "../../../../../lib/server/db";
import { shopProductList } from "../../../../../lib/server/products/shopCatalog";
import { SORTS } from "./catalog";
import type { ShopSort } from "../../../../../lib/server/products/shopCatalog";

const PAGE_SIZE = 24;

// SH-002 상품 목록·검색 결과: 제목·상품 수·정렬 → 격자(한 쪽 24개) → 이전·다음. 공개 상품 API와 같은 조회(shopProductList)를 쓴다.
// 없는 분류·보이지 않는 분류는 notFound를 돌려 주는 쪽(페이지)이 처리하도록 null을 돌려 준다.
export default async function ProductListing(props: {
  slug: string;
  title: string;
  path: string;
  sort: ShopSort;
  page: number;
  q?: string;
  categoryId?: string;
  crumb?: string; // 소분류일 때 「대분류 › 소분류」
  chips?: React.ReactNode; // 같은 대분류의 하위 칩
  empty: string;
}) {
  const ask = (page: number) => shopProductList(prisma, props.slug, { categoryId: props.categoryId, q: props.q, sort: props.sort, page: String(page), limit: String(PAGE_SIZE) });
  let r = await ask(props.page);
  if (!r.ok) return null;
  const pages = Math.max(1, Math.ceil(r.value.total / PAGE_SIZE));
  const page = Math.min(props.page, pages);
  if (page !== props.page) {
    r = await ask(page);
    if (!r.ok) return null;
  }
  const { products, total } = r.value;
  const href = (p: Partial<{ sort: ShopSort; page: number }>) => {
    const qs = new URLSearchParams();
    if (props.q) qs.set("q", props.q);
    if (props.categoryId) qs.set("category", props.categoryId);
    const sort = p.sort ?? props.sort;
    if (sort !== "new") qs.set("sort", sort);
    if (p.page && p.page > 1) qs.set("page", String(p.page));
    const s = qs.toString();
    return s ? `${props.path}?${s}` : props.path;
  };
  return (
    <section className="shop-sec" aria-labelledby="list-title">
      {props.crumb && <p className="shop-crumb">{props.crumb}</p>}
      <div className="shop-sec-head">
        <h1 id="list-title">
          {props.title} <span className="t-l2 c-alt">{total.toLocaleString("ko-KR")}개</span>
        </h1>
        {total > 0 && (
          <nav className="shop-sort" aria-label="정렬">
            {/* key: 정렬을 고르면(클라이언트 이동) 같은 요소가 열린 채 남지 않게 새로 그려 닫는다 */}
            <details key={props.sort} className="shop-sortmenu">
              <summary>{SORTS[props.sort]}</summary>
              <div>
                {(Object.keys(SORTS) as ShopSort[]).map((k) => (
                  <Link key={k} href={href({ sort: k })} aria-current={k === props.sort ? "page" : undefined}>
                    {SORTS[k]}
                  </Link>
                ))}
              </div>
            </details>
          </nav>
        )}
      </div>
      {props.chips}
      {products.length === 0 ? <p className="shop-empty">{props.empty}</p> : <ProductGrid products={products} label={props.title} hrefBase={`/shop/${encodeURIComponent(props.slug)}/products`} />}
      {pages > 1 && (
        <nav className="shop-pager" aria-label="쪽 이동">
          {page > 1 ? (
            <Link href={href({ page: page - 1 })} aria-label="이전 쪽">
              ‹
            </Link>
          ) : (
            <span aria-hidden="true" className="is-off">
              ‹
            </span>
          )}
          {pageNumbers(page, pages).map((n) => (
            <Link key={n} href={href({ page: n })} aria-current={n === page ? "page" : undefined} aria-label={`${n}쪽`}>
              {n}
            </Link>
          ))}
          {page < pages ? (
            <Link href={href({ page: page + 1 })} aria-label="다음 쪽">
              ›
            </Link>
          ) : (
            <span aria-hidden="true" className="is-off">
              ›
            </span>
          )}
        </nav>
      )}
      {pages > 1 && page === pages && (
        <div className="shop-listend">
          <p className="t-l2 c-alt">상품을 모두 봤어요 · {total.toLocaleString("ko-KR")}개</p>
          <Link className="btn btn-sm btn-out" href={`/shop/${encodeURIComponent(props.slug)}`}>
            홈으로
          </Link>
        </div>
      )}
    </section>
  );
}

// 쪽 번호: 7쪽까지는 모두, 그보다 많으면 지금 쪽 둘레 5개(첫 쪽·끝 쪽 쪽으로 붙여 보여 준다)
export function pageNumbers(page: number, pages: number): number[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const start = Math.min(Math.max(1, page - 2), pages - 4);
  return Array.from({ length: 5 }, (_, i) => start + i);
}

export const pageNumber = (v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 1 ? Math.min(n, 10000) : 1;
};
