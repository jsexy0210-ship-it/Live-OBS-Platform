import Link from "next/link";
import { ProductGrid } from "../../../../../components/shop/ProductCard";
import { shopProducts, SORTS, type SortKey } from "./catalog";

const PAGE_SIZE = 20;

// SH-002 상품 목록·검색 결과: 제목·상품 수·정렬 → 격자(한 쪽 20개) → 이전·다음.
// 인기순은 판매량 집계가 생기면 더한다.
export default async function ProductListing(props: {
  sellerId: string;
  title: string;
  path: string;
  sort: SortKey;
  page: number;
  q?: string;
  empty: string;
}) {
  const all = await shopProducts(props.sellerId, { q: props.q, sort: props.sort });
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(props.page, pages);
  const list = all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const href = (p: Partial<{ sort: SortKey; page: number }>) => {
    const qs = new URLSearchParams();
    if (props.q) qs.set("q", props.q);
    const sort = p.sort ?? props.sort;
    if (sort !== "new") qs.set("sort", sort);
    if (p.page && p.page > 1) qs.set("page", String(p.page));
    const s = qs.toString();
    return s ? `${props.path}?${s}` : props.path;
  };
  return (
    <section className="shop-sec" aria-labelledby="list-title">
      <div className="shop-sec-head">
        <h1 id="list-title">
          {props.title} <span className="t-l2 c-alt">{all.length.toLocaleString("ko-KR")}개</span>
        </h1>
        {all.length > 0 && (
          <nav className="shop-sort" aria-label="정렬">
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <Link key={k} href={href({ sort: k })} aria-current={k === props.sort ? "page" : undefined}>
                {SORTS[k]}
              </Link>
            ))}
          </nav>
        )}
      </div>
      {list.length === 0 ? <p className="shop-empty">{props.empty}</p> : <ProductGrid products={list} label={props.title} />}
      {pages > 1 && (
        <nav className="shop-pager" aria-label="쪽 이동">
          {page > 1 && (
            <Link className="btn btn-sm btn-out" href={href({ page: page - 1 })}>
              이전
            </Link>
          )}
          <span className="t-l2 c-alt" style={{ alignSelf: "center" }}>
            {page} / {pages}
          </span>
          {page < pages && (
            <Link className="btn btn-sm btn-out" href={href({ page: page + 1 })}>
              다음
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}

export const pageNumber = (v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 1 ? Math.min(n, 1000) : 1;
};
