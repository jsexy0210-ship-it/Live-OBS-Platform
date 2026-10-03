"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoImage, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, type Product, type ProductStatus } from "../../../../../components/seller/api";
import { LOW_STOCK, statusBadge, totalStock, won } from "../../../../../components/seller/format";

// SA-011 상품 목록. 상태별로 걸러 보고, 한 번에 50개씩 이어서 불러온다.
const FILTERS: { key: ProductStatus | "ALL"; label: string }[] = [
  { key: "ALL", label: "전체" },
  { key: "ON_SALE", label: "판매 중" },
  // 판매 상태를 「품절」로 정한 상품만. 판매 중인데 재고가 0인 상품은 「판매 중」 탭에 「재고 없음」 배지로 보인다
  { key: "SOLD_OUT", label: "품절로 설정" },
  { key: "HIDDEN", label: "숨김" },
  { key: "DRAFT", label: "임시 저장" },
];

const TOASTS: Record<string, string> = { created: "상품을 등록했어요", draft: "임시 저장했어요", deleted: "상품을 삭제했어요" };

type Page = { products: Product[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: Product[]; next: string | null };

const optionSummary = (p: Product) => (p.options.length === 0 ? "옵션 없음" : p.options.map((o) => o.name).join(" · "));

export default function ProductListPage() {
  const { can } = useSeller();
  const [filter, setFilter] = useState<ProductStatus | "ALL">("ALL");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 탭을 빨리 바꾸면 이전 탭 응답이 늦게 올 수 있다. 마지막으로 보낸 요청의 응답만 화면에 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (f: ProductStatus | "ALL") => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await api<Page>(`/api/seller/products${f === "ALL" ? "" : `?status=${f}`}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.products, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, []);

  useEffect(() => {
    void load(filter);
  }, [filter, load]);

  // 등록·삭제 뒤 돌아오면 한 번 알려 주고 주소에서 지운다
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("toast");
    if (q && TOASTS[q]) {
      setToast(TOASTS[q]);
      window.history.replaceState(null, "", "/seller/products");
    }
  }, []);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const qs = new URLSearchParams({ cursor: state.next, ...(filter === "ALL" ? {} : { status: filter }) });
    const r = await api<Page>(`/api/seller/products?${qs}`);
    setMore(false);
    if (id !== reqId.current) return;
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.products], next: r.data.nextCursor });
    else setToast("더 불러오지 못했어요. 다시 눌러 주세요");
  };

  const canManage = can("PRODUCT_MANAGE");
  const items = state.kind === "ok" ? state.items : [];
  const countText = state.kind === "ok" ? (state.next ? `${items.length}개 넘게` : `${items.length}`) : "";

  return (
    <>
      <Topbar crumb="판매 › 상품" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">
              상품 <span className="c-alt fw5">{countText}</span>
            </h1>
            <span className="t-l2 c-alt">판매 중인 상품은 쇼핑몰과 방송 주문대기에 바로 연결돼요.</span>
          </div>
          {canManage && (
            <div className="row" style={{ gap: 8 }}>
              <Link className="btn" href="/seller/products/new">
                상품 등록
              </Link>
            </div>
          )}
        </div>

        <div className="card" style={{ overflow: "hidden" }}>
          <div className="toolbar" style={{ padding: "14px 20px", boxShadow: "inset 0 -1px 0 var(--wds-line-normal-alternative)" }}>
            <div className="seg seg-scroll" role="tablist" aria-label="판매 상태">
              {FILTERS.map((f) => (
                <button key={f.key} type="button" role="tab" aria-selected={filter === f.key} className={filter === f.key ? "on" : ""} onClick={() => setFilter(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {state.kind === "loading" && <LoadingRows />}
          {state.kind === "error" &&
            (state.status === 403 ? (
              <NoPermission need="상품" />
            ) : state.status === 402 ? (
              <Locked />
            ) : (
              <ErrorState title="상품을 불러오지 못했어요" onRetry={() => void load(filter)} />
            ))}
          {state.kind === "ok" && items.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">+</div>
              {filter === "ALL" ? (
                <>
                  <span className="t">아직 등록된 상품이 없어요</span>
                  <span className="s">첫 상품을 등록하면 쇼핑몰에 바로 보여요.</span>
                  {canManage && (
                    <Link className="btn btn-sm" href="/seller/products/new">
                      상품 등록
                    </Link>
                  )}
                </>
              ) : (
                <>
                  <span className="t">「{FILTERS.find((f) => f.key === filter)?.label}」에 해당하는 상품이 없어요</span>
                  <button className="btn btn-sm btn-text" type="button" onClick={() => setFilter("ALL")}>
                    전체 보기
                  </button>
                </>
              )}
            </div>
          )}
          {state.kind === "ok" && items.length > 0 && (
            <>
              <table className="tbl p-table">
                <thead>
                  <tr>
                    <th style={{ width: 64 }} />
                    <th>상품</th>
                    <th className="r" style={{ width: 140 }}>
                      판매가
                    </th>
                    <th className="r" style={{ width: 100 }}>
                      재고
                    </th>
                    <th style={{ width: 110 }}>상태</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((p) => {
                    const b = statusBadge(p);
                    const stock = totalStock(p);
                    return (
                      <tr key={p.id} className="p-row" data-testid="product-row">
                        <td>
                          <div className="img" style={{ width: 44, height: 44, borderRadius: 8 }} title="이미지 없음">
                            <NoImage />
                          </div>
                        </td>
                        <td>
                          <Link href={`/seller/products/${p.id}`} className="fw6 p-name" style={{ color: "inherit", textDecoration: "none" }}>
                            {p.name}
                          </Link>
                          <div className="t-c1 c-alt ell">{optionSummary(p)}</div>
                        </td>
                        <td className="r num">{won(p.price)}</td>
                        <td className={`r num${stock === 0 ? " c-neg fw6" : stock <= LOW_STOCK ? " c-cau fw6" : ""}`}>{stock.toLocaleString("ko-KR")}</td>
                        <td>
                          <span className={`bdg ${b.cls}`}>{b.label}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <ul className="p-cards">
                {items.map((p) => {
                  const b = statusBadge(p);
                  const stock = totalStock(p);
                  return (
                    <li key={p.id}>
                      <Link href={`/seller/products/${p.id}`} className="p-card" data-testid="product-card">
                        <div className="img" style={{ width: 64, height: 64 }} title="이미지 없음">
                          <NoImage size={24} />
                        </div>
                        <div className="col grow" style={{ gap: 4 }}>
                          <span className="fw6 p-name">{p.name}</span>
                          <span className="t-c1 c-alt ell">{optionSummary(p)}</span>
                          <span className="row between" style={{ gap: 8 }}>
                            <span className="fw7 num">{won(p.price)}</span>
                            <span className="row" style={{ gap: 6 }}>
                              <span className={`t-c1 num${stock === 0 ? " c-neg fw6" : stock <= LOW_STOCK ? " c-cau fw6" : " c-alt"}`}>재고 {stock.toLocaleString("ko-KR")}</span>
                              <span className={`bdg ${b.cls}`}>{b.label}</span>
                            </span>
                          </span>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
              <div className="row center" style={{ padding: "12px 20px", minHeight: 56 }}>
                {state.next ? (
                  <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                    {more ? "불러오고 있어요" : "더 보기"}
                  </button>
                ) : (
                  <span className="t-l2 c-alt">모두 불러왔어요</span>
                )}
              </div>
            </>
          )}
        </div>
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
