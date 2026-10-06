import Link from "next/link";
import ProductFilter from "../../../../../components/shop/ProductFilter";
import type { PublicCategory } from "../../../../../lib/server/shop-category/service";
import { defaultSort, sortChoices, type ListSort } from "./catalog";
import type { Filters } from "./filters";

// SH-002 상품 목록·검색의 왼쪽 열(PC): 전체 카테고리(휴대폰에서는 숨김) + 「검색 조건」 패널(휴대폰에서는 「필터」 아래 시트). 두 화면이 같은 것을 쓴다.
export default function ListSide(props: { slug: string; tree: PublicCategory[]; currentId?: string; path: string; q?: string; sort: ListSort; filters: Filters }) {
  const base = `/shop/${encodeURIComponent(props.slug)}`;
  const hasQuery = !!props.q;
  return (
    <div className="shop-side">
      <aside className="shop-sidecat" aria-label="카테고리">
        <p className="shop-sidecat-h">전체 카테고리</p>
        <Link href={`${base}/products`} aria-current={!props.currentId && !hasQuery ? "page" : undefined}>
          전체
        </Link>
        {props.tree.map((c) => (
          <div key={c.id}>
            <Link className="top" href={`${base}/products?category=${c.id}`} aria-current={props.currentId === c.id ? "page" : undefined}>
              {c.name}
            </Link>
            {c.children.map((x) => (
              <Link key={x.id} className="sub" href={`${base}/products?category=${x.id}`} aria-current={props.currentId === x.id ? "page" : undefined}>
                {x.name}
              </Link>
            ))}
          </div>
        ))}
      </aside>
      <ProductFilter
        slug={props.slug}
        path={props.path}
        q={props.q}
        category={props.currentId}
        sort={props.sort}
        defaultSort={defaultSort(hasQuery)}
        sorts={sortChoices(hasQuery)}
        tree={props.tree}
        initial={props.filters}
      />
    </div>
  );
}
