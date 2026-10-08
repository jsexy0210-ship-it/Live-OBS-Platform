import Link from "next/link";
import { Pagination } from "../../../../../components/Pagination";
import { ProductGrid } from "../../../../../components/shop/ProductCard";
import { prisma } from "../../../../../lib/server/db";
import { shopProductList } from "../../../../../lib/server/products/shopCatalog";
import { defaultSort, sortChoices, type ListSort } from "./catalog";
import { filterCount, filterParams, priceLabel, type Filters } from "./filters";
import type { PublicCategory } from "../../../../../lib/server/shop-category/service";
import { FilterOpenButton } from "../../../../../components/shop/ProductFilter";
import SortMenu from "../../../../../components/shop/SortMenu";

const PAGE_SIZE = 24;

// SH-002 상품 목록·검색 결과: 제목·상품 수·정렬 → 격자(한 쪽 24개) → 이전·다음. 공개 상품 API와 같은 조회(shopProductList)를 쓴다.
// 없는 분류·보이지 않는 분류는 notFound를 돌려 주는 쪽(페이지)이 처리하도록 null을 돌려 준다.
export default async function ProductListing(props: {
  slug: string;
  title: string;
  path: string;
  sort: ListSort;
  filters: Filters;
  tree: PublicCategory[]; // 필터 칩 이름용
  page: number;
  q?: string;
  categoryId?: string;
  crumb?: string; // 소분류일 때 「대분류 › 소분류」
  chips?: React.ReactNode; // 같은 대분류의 하위 칩
  empty: string;
}) {
  const f = props.filters;
  const categoryIds = [props.categoryId, ...f.cats].filter(Boolean).slice(0, 5).join(",");
  const ask = (page: number) =>
    shopProductList(prisma, props.slug, {
      categoryId: categoryIds || undefined,
      q: props.q,
      sort: props.sort,
      page: String(page),
      limit: String(PAGE_SIZE),
      inStock: f.inStock ? "1" : undefined,
      live: f.live ? "1" : undefined,
      rating4: f.rating4 ? "1" : undefined,
      coupon: f.coupon ? "1" : undefined,
      minPrice: f.min || undefined,
      maxPrice: f.max || undefined,
    });
  let r = await ask(props.page);
  if (!r.ok) return null;
  const pages = Math.max(1, Math.ceil(r.value.total / PAGE_SIZE));
  const page = Math.min(props.page, pages);
  if (page !== props.page) {
    r = await ask(page);
    if (!r.ok) return null;
  }
  const { products, total } = r.value;
  const dflt = defaultSort(!!props.q);
  // 주소 만들기: 검색어·분류·필터·정렬·쪽을 모두 이어 간다(바꾸는 것만 덮어쓴다)
  const href = (p: Partial<{ sort: ListSort; page: number; filters: Filters }>) => {
    const qs = new URLSearchParams();
    if (props.q) qs.set("q", props.q);
    if (props.categoryId) qs.set("category", props.categoryId);
    filterParams(p.filters ?? f, qs);
    const sort = p.sort ?? props.sort;
    if (sort !== dflt) qs.set("sort", sort);
    if (p.page && p.page > 1) qs.set("page", String(p.page));
    const s = qs.toString();
    return s ? `${props.path}?${s}` : props.path;
  };
  const nameOf = (id: string) => props.tree.flatMap((c) => c.children).find((x) => x.id === id)?.name ?? "";
  // 적용한 조건 칩(×를 누르면 그 조건만 빠진다)
  const chips: { label: string; to: Filters }[] = [
    ...f.cats.map((id) => ({ label: nameOf(id), to: { ...f, cats: f.cats.filter((c) => c !== id) } })),
    ...(f.inStock ? [{ label: "재고 있는 상품만", to: { ...f, inStock: false } }] : []),
    ...(f.live ? [{ label: "방송 중 상품만", to: { ...f, live: false } }] : []),
    ...(f.rating4 ? [{ label: "평점 4점 이상", to: { ...f, rating4: false } }] : []),
    ...(f.coupon ? [{ label: "쿠폰 적용 가능", to: { ...f, coupon: false } }] : []),
    ...(f.min || f.max ? [{ label: priceLabel(f), to: { ...f, min: "", max: "" } }] : []),
  ].filter((c) => c.label);
  const cleared: Filters = { cats: [], inStock: false, live: false, rating4: false, coupon: false, min: "", max: "" };
  return (
    <section className="shop-sec" aria-labelledby="list-title">
      {props.crumb && <p className="shop-crumb">{props.crumb}</p>}
      <div className="shop-sec-head">
        <h1 id="list-title">
          {props.title} <span className="t-l2 c-alt">{total.toLocaleString("ko-KR")}개</span>
        </h1>
        <div className="shop-sec-tools">
          {(total > 0 || filterCount(f) > 0) && <FilterOpenButton count={filterCount(f)} />}
          {total > 0 && (
            <nav className="shop-sort" aria-label="정렬">
              <SortMenu current={props.sort} items={sortChoices(!!props.q).map((x) => ({ key: x.key, label: x.label, href: href({ sort: x.key as ListSort }) }))} />
            </nav>
          )}
        </div>
      </div>
      {props.chips}
      {chips.length > 0 && (
        <div className="fl-applied" aria-label="적용한 조건">
          {chips.map((c) => (
            <Link key={c.label} className="shop-chip" href={href({ filters: c.to })} aria-label={`${c.label} 조건 지우기`}>
              {c.label} <span aria-hidden="true">×</span>
            </Link>
          ))}
          <Link className="fl-clear" href={href({ filters: cleared })}>
            모두 지우기
          </Link>
        </div>
      )}
      {products.length === 0 ? (
        filterCount(f) > 0 ? (
          <div className="shop-empty">
            <p>필터 조건에 맞는 상품이 없어요. 필터를 줄여 보세요</p>
            <Link className="btn btn-sm btn-out" href={href({ filters: cleared })}>
              필터 모두 지우기
            </Link>
          </div>
        ) : (
          <p className="shop-empty">{props.empty}</p>
        )
      ) : <ProductGrid products={products} label={props.title} hrefBase={`/shop/${encodeURIComponent(props.slug)}/products`} />}
      <Pagination page={page} pageCount={Math.ceil(total / PAGE_SIZE)} href={n => href({ page: n })} label="쪽 이동" />
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

export { pageNumbers } from "../../../../../components/Pagination";

export const pageNumber = (v: string | undefined) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 1 ? Math.min(n, 10000) : 1;
};
