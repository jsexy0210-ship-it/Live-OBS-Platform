"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { STATUS_BADGE, failText, moved, useDraft, type CatItem, type CategoryNode } from "./types";

// 카테고리별 진열: 카테고리 안 상품 순서(직접 지정한 상품). 위·아래로 옮기고 「순서 저장」을 누른다(PUT /api/seller/categories/[id]/products, 그사이 목록이 바뀌면 409).
export function CategoryOrder({ cats, notify }: { cats: CategoryNode[]; notify: (text: string, neg?: boolean) => void }) {
  const all = cats.flatMap((p) => [{ id: p.id, name: p.name }, ...p.children.map((c) => ({ id: c.id, name: `${p.name} › ${c.name}` }))]);
  const [sel, setSel] = useState(all[0]?.id ?? "");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ok"; items: CatItem[] }>({ kind: "loading" });
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const items = state.kind === "ok" ? state.items : [];
  const [draft, setDraft, dirty] = useDraft(items);

  const load = useCallback(async (id: string) => {
    setStale(false);
    setState({ kind: "loading" });
    const r = await api<{ products: CatItem[] }>(`/api/seller/categories/${id}/products`);
    setState(r.ok ? { kind: "ok", items: r.data.products } : { kind: "error" });
  }, []);
  useEffect(() => {
    if (sel) void load(sel);
  }, [sel, load]);

  const save = async () => {
    setBusy(true);
    const r = await api<{ products: CatItem[] }>(`/api/seller/categories/${sel}/products`, { method: "PUT", body: { productIds: draft.map((i) => i.productId) } });
    setBusy(false);
    if (!r.ok) {
      if (r.error === "invalid_category_order") return setStale(true);
      return notify(failText(r, "순서를 저장하지 못했습니다. 다시 시도해 주십시오"), true);
    }
    setState({ kind: "ok", items: r.data.products });
    notify("카테고리 안 순서를 저장했습니다 · 쇼핑몰에 바로 반영");
  };

  return (
    <section className="card" style={{ padding: 16 }} aria-label="카테고리별 진열">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="t-h2">카테고리별 진열</h2>
        <button className="btn" type="button" disabled={!dirty || busy || stale} onClick={() => void save()}>
          {busy ? "저장 중" : "순서 저장"}
        </button>
      </div>
      {all.length === 0 ? (
        <span className="t-l2 c-alt">카테고리가 없습니다. 카테고리를 먼저 만들어 주십시오.</span>
      ) : (
        <>
          <label className="col" style={{ gap: 4, maxWidth: 360, marginTop: 8 }}>
            <span className="t-l2">카테고리</span>
            <select className="inp" value={sel} onChange={(e) => setSel(e.target.value)} disabled={busy}>
              {all.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {stale && (
            <div className="msg msg-neg" role="alert">
              <span>
                <b>순서를 저장하지 못했습니다.</b> 그사이 다른 창에서 이 카테고리의 상품이 바뀌었습니다. 새로 고친 뒤 다시 바꿔 주십시오.
              </span>
              <button className="btn btn-sm" type="button" onClick={() => void load(sel)}>
                새로 고침
              </button>
            </div>
          )}
          {state.kind === "loading" && <span className="t-l2 c-alt">불러오는 중입니다</span>}
          {state.kind === "error" && (
            <div className="row" style={{ gap: 8 }}>
              <span className="t-l2 c-neg">상품을 불러오지 못했습니다.</span>
              <button className="btn btn-sm" type="button" onClick={() => void load(sel)}>
                다시 시도
              </button>
            </div>
          )}
          {state.kind === "ok" && draft.length === 0 && <span className="t-l2 c-alt">이 카테고리에 지정한 상품이 없습니다. 상품 등록·수정에서 카테고리를 고르면 여기에 나옵니다.</span>}
          {state.kind === "ok" && draft.length > 0 && (
            <div className="au-lt-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>순서</th>
                    <th>상품</th>
                    <th>상태</th>
                    <th>순서 바꾸기</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.map((p, i) => (
                    <tr key={p.productId} data-testid="category-product-row">
                      <td className="num">{i + 1}</td>
                      <td>{p.name}</td>
                      <td>
                        <span className={`bdg ${STATUS_BADGE[p.status].cls}`}>{STATUS_BADGE[p.status].label}</span>
                      </td>
                      <td>
                        <span className="row" style={{ gap: 2 }}>
                          <button className="btn btn-sm btn-out" type="button" aria-label={`${p.name} 위로`} disabled={i === 0} onClick={() => setDraft((d) => moved(d, i, i - 1))}>
                            ▲
                          </button>
                          <button className="btn btn-sm btn-out" type="button" aria-label={`${p.name} 아래로`} disabled={i === draft.length - 1} onClick={() => setDraft((d) => moved(d, i, i + 1))}>
                            ▼
                          </button>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <span className="t-c1 c-alt">카테고리 안 순서입니다 · 기본은 진열 순서이고, 카테고리 영역은 이 순서로 홈에 보입니다.</span>
        </>
      )}
    </section>
  );
}
