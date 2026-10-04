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
      <div className="shop-sec-head">
        <h1 id="list-title">
          {props.title} <span className="t-l2 c-alt">{total.toLocaleString("ko-KR")}개</span>
        </h1>
        {total > 0 && (
          <nav className="shop-sort" aria-label="정렬">
            {(Object.keys(SORTS) as ShopSort[]).map((k) => (
              <Link key={k} href={href({ sort: k })} aria-current={k === props.sort ? "page" : undefined}>
                {SORTS[k]}
              </Link>
            ))}
          </nav>
        )}
      </div>
      {products.length === 0 ? <p className="shop-empty">{props.empty}</p> : <ProductGrid products={products} label={props.title} />}
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
  return Number.isInteger(n) && n > 1 ? Math.min(n, 10000) : 1;
};
