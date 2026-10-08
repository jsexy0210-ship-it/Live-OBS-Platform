"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ModalClose } from "./ShopModal";

// SH-002 필터(보드 SH-002-F 휴대폰 시트 · SH-002-PC-IA 「검색 조건」 패널). 같은 폼을 PC에서는 왼쪽 패널로, 휴대폰에서는 「필터」 버튼으로 여는 아래 시트로 보여 준다.
// 분류(대분류마다 하위 하나) · 가격 · 재고 있는 상품만 · 방송 중 상품만 · 평점(PC) · 정렬(휴대폰). 바꿀 때마다 공개 상품 API(limit=1)로 「상품 N개」를 미리 센다.
// 「쿠폰 적용 가능」은 비로그인 목록의 적용 범위 계약이 확정되지 않아 넣지 않았다.
export const FILTER_OPEN_EVENT = "shop-filter-open";
type Cat = { id: string; name: string; children: { id: string; name: string }[] };
type Props = {
  slug: string;
  path: string;
  q?: string;
  category?: string; // 지금 보는 분류(왼쪽 메뉴·칩에서 고른 것)
  sort: string;
  defaultSort: string;
  sorts: { key: string; label: string }[];
  tree: Cat[];
  initial: { cats: string[]; inStock: boolean; live: boolean; rating4: boolean; min: string; max: string };
};

export function FilterOpenButton({ count }: { count: number }) {
  return (
    <button type="button" className="fl-open" onClick={() => window.dispatchEvent(new Event(FILTER_OPEN_EVENT))}>
      필터 {count > 0 && <b>{count}</b>}
    </button>
  );
}

export default function ProductFilter({ slug, path, q, category, sort: sortNow, defaultSort, sorts, tree, initial }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [cats, setCats] = useState<string[]>(initial.cats);
  const [inStock, setInStock] = useState(initial.inStock);
  const [live, setLive] = useState(initial.live);
  const [rating4, setRating4] = useState(initial.rating4);
  const [min, setMin] = useState(initial.min);
  const [max, setMax] = useState(initial.max);
  const [sort, setSort] = useState(sortNow);
  const [count, setCount] = useState<number | null>(null);

  // 주소가 바뀌면(칩의 ×·모두 지우기·쪽 이동) 폼도 주소 값으로 맞춘다
  const initKey = JSON.stringify(initial) + sortNow;
  useEffect(() => {
    setCats(initial.cats);
    setInStock(initial.inStock);
    setLive(initial.live);
    setRating4(initial.rating4);
    setMin(initial.min);
    setMax(initial.max);
    setSort(sortNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initKey]);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(FILTER_OPEN_EVENT, on);
    return () => window.removeEventListener(FILTER_OPEN_EVENT, on);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const bad = min !== "" && max !== "" && Number(min) > Number(max);
  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (category) p.set("category", category);
    if (cats.length) p.set("cats", cats.join(","));
    if (inStock) p.set("inStock", "1");
    if (live) p.set("live", "1");
    if (rating4) p.set("rating4", "1");
    if (!bad && min) p.set("minPrice", min);
    if (!bad && max) p.set("maxPrice", max);
    return p;
  }, [q, category, cats, inStock, live, rating4, min, max, bad]);

  // 조건에 맞는 상품 수(공개 상품 API, 한 개만 받아 total을 쓴다)
  useEffect(() => {
    if (bad) return setCount(null);
    const api = new URLSearchParams();
    if (q) api.set("q", q);
    const ids = [category, ...cats].filter(Boolean).join(",");
    if (ids) api.set("categoryId", ids);
    for (const k of ["inStock", "live", "rating4", "minPrice", "maxPrice"]) if (query.get(k)) api.set(k, query.get(k)!);
    api.set("limit", "1");
    let live_ = true;
    const t = setTimeout(() => {
      fetch(`/api/shop/${encodeURIComponent(slug)}/products?${api}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { total?: number } | null) => live_ && setCount(typeof j?.total === "number" ? j.total : null))
        .catch(() => live_ && setCount(null));
    }, 250);
    return () => {
      live_ = false;
      clearTimeout(t);
    };
  }, [slug, q, category, cats, query, bad]);

  const changed = JSON.stringify([cats, inStock, live, rating4, bad ? "" : min, bad ? "" : max, sort]) !== JSON.stringify([initial.cats, initial.inStock, initial.live, initial.rating4, initial.min, initial.max, sortNow]);
  const none = count === 0;
  const submitOff = bad || none;

  function pick(group: Cat, id: string | null) {
    setCats((cur) => {
      const rest = cur.filter((c) => !group.children.some((x) => x.id === c));
      return id ? [...rest, id] : rest;
    });
  }
  function reset() {
    setCats([]);
    setInStock(false);
    setLive(false);
    setRating4(false);
    setMin("");
    setMax("");
    setSort(defaultSort);
  }
  function apply(e: React.FormEvent) {
    e.preventDefault();
    if (submitOff) return;
    const p = new URLSearchParams(query);
    if (sort !== defaultSort) p.set("sort", sort);
    const s = p.toString();
    setOpen(false);
    router.push(s ? `${path}?${s}` : path);
  }
  const digits = (v: string) => v.replace(/\D/g, "").slice(0, 9);

  return (
    <div className={`fl-wrap${open ? " is-open" : ""}`}>
      {open && <div className="fl-bg" onClick={() => setOpen(false)} aria-hidden="true" />}
      <form className="fl" aria-label="검색 조건" onSubmit={apply} noValidate>
        <div className="fl-head fl-m-only">
          <h2>필터</h2>
          <ModalClose onClick={() => setOpen(false)} />
        </div>
        <h2 className="fl-h fl-pc-only">검색 조건</h2>
        <div className="fl-body">
          {tree
            .filter((g) => g.children.length > 0)
            .map((g) => (
              <fieldset key={g.id} className="fl-group fl-m-only">
                <legend>{g.name}</legend>
                <div className="fl-chips-in">
                  <button type="button" className="shop-chip" aria-pressed={!g.children.some((x) => cats.includes(x.id))} onClick={() => pick(g, null)}>
                    전체
                  </button>
                  {g.children.map((x) => (
                    <button key={x.id} type="button" className="shop-chip" aria-pressed={cats.includes(x.id)} onClick={() => pick(g, x.id)}>
                      {x.name}
                    </button>
                  ))}
                </div>
              </fieldset>
            ))}
          <fieldset className="fl-group">
            <legend>가격</legend>
            <div className="fl-price">
              <input className="inp" inputMode="numeric" placeholder="최소" aria-label="최소 가격" value={min} aria-invalid={bad} onChange={(e) => setMin(digits(e.target.value))} />
              <span aria-hidden="true">~</span>
              <input className="inp" inputMode="numeric" placeholder="최대" aria-label="최대 가격" value={max} aria-invalid={bad} onChange={(e) => setMax(digits(e.target.value))} />
              <span>원</span>
            </div>
            {bad && (
              <p className="err" role="alert">
                최대 가격이 최소 가격보다 작아요
              </p>
            )}
          </fieldset>
          <div className="fl-group">
            <label className="chk">
              <input type="checkbox" className="cbx" checked={inStock} onChange={(e) => setInStock(e.target.checked)} />
              재고 있는 상품만
            </label>
            <label className="chk">
              <input type="checkbox" className="cbx" checked={live} onChange={(e) => setLive(e.target.checked)} />
              방송 중 상품만
            </label>
            <label className="chk fl-pc-only">
              <input type="checkbox" className="cbx" checked={rating4} onChange={(e) => setRating4(e.target.checked)} />
              평점 4점 이상
            </label>
          </div>
          <fieldset className="fl-group fl-m-only">
            <legend>정렬</legend>
            {sorts.map((s) => (
              <label key={s.key} className="chk">
                <input type="radio" name="fl-sort" checked={sort === s.key} onChange={() => setSort(s.key)} />
                {s.label}
              </label>
            ))}
          </fieldset>
        </div>
        <div className="fl-foot">
          <button type="button" className="btn btn-out" onClick={reset}>
            초기화
          </button>
          <button type="submit" className="btn fl-pc-only" disabled={submitOff || !changed}>
            적용
          </button>
          <button type="submit" className="btn fl-m-only" disabled={submitOff}>
            {none ? "맞는 상품이 없어요" : count !== null ? `상품 ${count.toLocaleString("ko-KR")}개 보기` : "상품 보기"}
          </button>
        </div>
        {none && <p className="fl-hint">조건을 줄여 주세요</p>}
      </form>
    </div>
  );
}
