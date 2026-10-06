"use client";

import { useEffect, useRef, useState } from "react";
import { api, type Product } from "../../../../../../components/seller/api";
import { categoryOptions, type CategoryNode } from "../../../../../../components/seller/ProductCategoryPicker";
import { linkLooksOk } from "./ui";

// 배너·팝업 「연결」 고르기(SA-064 정본 「연결」 선택 상자). 연결 없음 / 상품 상세(검색해서 고름) / 카테고리 / 직접 입력한 주소.
// 값은 구매자 화면 규칙의 링크 문자열 하나다: 상품 상세 → /products/{상품 id}, 카테고리 → /products?category={카테고리 id}, 직접 입력 → 경로(/…) 또는 http(s) 주소.
type Kind = "none" | "product" | "category" | "custom";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PRODUCT = new RegExp(`^/products/(${UUID})$`, "i");
const CATEGORY = new RegExp(`^/products\\?category=(${UUID})$`, "i");

export function kindOfLink(link: string): Kind {
  if (!link) return "none";
  if (PRODUCT.test(link)) return "product";
  if (CATEGORY.test(link)) return "category";
  return "custom";
}
// 표에 보이는 짧은 설명
export const linkSummary = (link: string | null) => (!link ? "—" : kindOfLink(link) === "product" ? "상품 상세" : kindOfLink(link) === "category" ? "카테고리" : link);

type Found = { id: string; name: string };

export default function LinkPicker({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const [kind, setKind] = useState<Kind>(() => kindOfLink(value));
  const [cats, setCats] = useState<CategoryNode[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<Found[] | null>(null);
  const [searchFailed, setSearchFailed] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const productId = PRODUCT.exec(value)?.[1] ?? null;
  const seq = useRef(0);

  // 이미 고른 상품의 이름
  useEffect(() => {
    if (!productId) return setName(null);
    let live = true;
    void api<Product>(`/api/seller/products/${productId}`).then((r) => live && setName(r.ok ? r.data.name : null));
    return () => {
      live = false;
    };
  }, [productId]);

  // 카테고리는 고를 때 한 번만 읽는다
  useEffect(() => {
    if (kind !== "category" || cats) return;
    void api<{ categories: CategoryNode[] }>("/api/seller/categories").then((r) => setCats(r.ok ? r.data.categories : []));
  }, [kind, cats]);

  // 상품 이름 검색(입력이 멈춘 뒤)
  useEffect(() => {
    if (kind !== "product" || q.trim() === "") {
      setFound(null);
      return;
    }
    const id = ++seq.current;
    const t = setTimeout(async () => {
      const r = await api<{ products: Product[] }>(`/api/seller/products?q=${encodeURIComponent(q.trim().slice(0, 50))}&limit=8`);
      if (id !== seq.current) return;
      setSearchFailed(!r.ok);
      setFound(r.ok ? r.data.products.map((p) => ({ id: p.id, name: p.name })) : []);
    }, 250);
    return () => clearTimeout(t);
  }, [kind, q]);

  const pickKind = (k: Kind) => {
    setKind(k);
    setQ("");
    setFound(null);
    if (k === "none") onChange("");
    else if (k !== kindOfLink(value)) onChange("");
  };
  const selectedCategory = CATEGORY.exec(value)?.[1] ?? "";

  return (
    <div className="sc-link">
      <select id="banner-link-kind" className="inp" style={{ maxWidth: 360 }} aria-label="연결" value={kind} disabled={disabled} onChange={(e) => pickKind(e.target.value as Kind)}>
        <option value="none">연결 없음</option>
        <option value="product">상품 상세</option>
        <option value="category">카테고리</option>
        <option value="custom">직접 입력한 주소</option>
      </select>
      {kind === "product" && (
        <div className="sc-link-body">
          {productId && (
            <span className="t-l2 fw6" data-testid="link-product">
              상품 상세 · {name ?? "불러오는 중"}
            </span>
          )}
          <input
            className="inp"
            style={{ maxWidth: 360 }}
            aria-label="상품 이름 검색"
            placeholder="상품 이름을 검색해 고르십시오"
            maxLength={50}
            value={q}
            disabled={disabled}
            onChange={(e) => setQ(e.target.value)}
          />
          {found && found.length > 0 && (
            <ul className="sc-link-list" aria-label="검색한 상품">
              {found.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className="sc-link-opt"
                    onClick={() => {
                      onChange(`/products/${f.id}`);
                      setName(f.name);
                      setQ("");
                      setFound(null);
                    }}
                  >
                    {f.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {found && found.length === 0 && <span className="help">{searchFailed ? "상품을 불러오지 못했습니다. 직접 입력한 주소로 연결할 수 있습니다" : "찾는 상품이 없습니다"}</span>}
          {!productId && !found && <span className="help">상품을 고르면 그 상품 상세 화면으로 연결됩니다</span>}
        </div>
      )}
      {kind === "category" && (
        <div className="sc-link-body">
          <select
            className="inp"
            style={{ maxWidth: 360 }}
            aria-label="카테고리"
            value={selectedCategory}
            disabled={disabled || !cats}
            onChange={(e) => onChange(e.target.value ? `/products?category=${e.target.value}` : "")}
          >
            <option value="">{cats ? "카테고리를 고르십시오" : "불러오는 중"}</option>
            {cats &&
              categoryOptions(cats).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
          </select>
          {cats && cats.length === 0 && <span className="help">등록한 카테고리가 없습니다</span>}
        </div>
      )}
      {kind === "custom" && (
        <div className="sc-link-body">
          <input
            className={`inp${linkLooksOk(value) ? "" : " is-error"}`}
            style={{ maxWidth: 360 }}
            aria-label="연결 주소"
            placeholder="/products/상품 주소 또는 https://"
            maxLength={500}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          />
          {linkLooksOk(value) ? (
            <span className="help">쇼핑몰 안 경로는 쇼핑몰 주소 뒤에 붙음 · 바깥 주소는 새 창으로 열림</span>
          ) : (
            <span className="err">쇼핑몰 안 경로(/로 시작) 또는 http(s) 주소만 입력할 수 있습니다</span>
          )}
        </div>
      )}
    </div>
  );
}
