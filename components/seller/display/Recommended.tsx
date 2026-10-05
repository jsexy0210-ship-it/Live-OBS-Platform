"use client";

import { useEffect, useState } from "react";
import { Modal } from "../../admin-ui";
import { api, type Product } from "../api";
import { won } from "../format";
import { MAX_RECOMMENDED, STATUS_BADGE, failText, moved, useDraft, type Display, type RecItem } from "./types";

// 추천 상품: 홈 「추천 상품」 영역에 직접 고른 순서로 최대 20개. 추가·빼기·순서는 화면에서 먼저 바꾸고 「추천 상품 저장」으로 통째로 저장한다(PUT /api/seller/display/recommended).
// 상품 검색은 GET /api/seller/products?q=. 삭제된 상품은 서버가 목록에서 자동으로 뺀다.
type Found = Pick<Product, "id" | "code" | "name" | "price" | "status" | "options">;
const stockOf = (p: Found) => p.options.reduce((s, o) => s + o.stock, 0);

export function Recommended({ items, onSaved, notify }: { items: RecItem[]; onSaved: (d: Display) => void; notify: (text: string, neg?: boolean) => void }) {
  const server = items.filter((i) => !i.deleted);
  const [draft, setDraft, dirty] = useDraft(server);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [removing, setRemoving] = useState<RecItem | null>(null);

  const save = async () => {
    setBusy(true);
    const r = await api<Display>("/api/seller/display/recommended", { method: "PUT", body: { productIds: draft.map((i) => i.productId) } });
    setBusy(false);
    if (!r.ok) return notify(failText(r, "추천 상품을 저장하지 못했습니다. 다시 시도해 주십시오"), true);
    onSaved(r.data);
    notify("추천 상품을 저장했습니다 · 쇼핑몰에 바로 반영");
  };
  const full = draft.length >= MAX_RECOMMENDED;

  return (
    <section className="card" style={{ padding: 16 }} aria-label="추천 상품">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="t-h2">
          추천 상품 <span className="t-l2 c-alt">{draft.length}개 · 최대 {MAX_RECOMMENDED}개</span>
        </h2>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn btn-out" type="button" disabled={full} onClick={() => setPicker(true)}>
            상품 추가
          </button>
          <button className="btn" type="button" disabled={!dirty || busy} onClick={() => void save()}>
            {busy ? "저장 중" : "추천 상품 저장"}
          </button>
        </div>
      </div>
      {full && (
        <div className="msg msg-cau" role="status">
          <span>
            <b>추천 상품은 {MAX_RECOMMENDED}개까지 넣을 수 있습니다.</b> 빼고 추가하거나 「베스트」 자동 영역을 사용해 주십시오.
          </span>
        </div>
      )}
      {draft.length === 0 ? (
        <div className="st" style={{ boxShadow: "none" }}>
          <div className="st-ic">+</div>
          <span className="t">추천할 상품이 없습니다</span>
          <span className="s">상품을 추가하면 홈의 추천 영역에 보입니다.</span>
        </div>
      ) : (
        <div className="au-lt-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>순서</th>
                <th>상품</th>
                <th>상태</th>
                <th>순서 바꾸기</th>
                <th aria-label="관리" />
              </tr>
            </thead>
            <tbody>
              {draft.map((p, i) => (
                <tr key={p.productId} data-testid="recommended-row">
                  <td className="num">{i + 1}</td>
                  <td>
                    <b>{p.name}</b>
                    <div className="t-c1 c-alt">{p.code}</div>
                  </td>
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
                      <button className="btn btn-sm btn-out" type="button" disabled={i === 0} onClick={() => setDraft((d) => moved(d, i, 0))}>
                        맨 위로
                      </button>
                    </span>
                  </td>
                  <td>
                    <button className="btn btn-sm btn-out" type="button" onClick={() => setRemoving(p)}>
                      빼기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <span className="t-c1 c-alt">바꾼 뒤 「추천 상품 저장」을 눌러야 쇼핑몰에 반영됩니다 · 삭제된 상품은 자동으로 빠집니다.</span>

      {picker && <Picker taken={new Set(draft.map((i) => i.productId))} room={MAX_RECOMMENDED - draft.length} onAdd={(p) => setDraft((d) => [...d, { productId: p.id, code: p.code ?? "", name: p.name, status: p.status, deleted: false, thumbnailUrl: null }])} onClose={() => setPicker(false)} />}
      {removing && (
        <Modal labelId="rec-del-title" onClose={() => setRemoving(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="rec-del-title">
              추천 상품에서 빼시겠습니까?
            </h2>
            <span className="t-l2 c-alt">「{removing.name}」를 추천 영역에서 뺍니다. 상품 자체는 그대로 판매됩니다.</span>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setRemoving(null)}>
              취소
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                setDraft((d) => d.filter((x) => x.productId !== removing.productId));
                setRemoving(null);
              }}
            >
              빼기
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}

function Picker({ taken, room, onAdd, onClose }: { taken: Set<string>; room: number; onAdd: (p: Found) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ok"; items: Found[] }>({ kind: "loading" });
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const r = await api<{ products: Found[] }>(`/api/seller/products?limit=10${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`);
      if (live) setFound(r.ok ? { kind: "ok", items: r.data.products } : { kind: "error" });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  return (
    <Modal labelId="rec-pick-title" onClose={onClose}>
      <div className="modal-h">
        <h2 className="modal-t" id="rec-pick-title">
          추천 상품 추가
        </h2>
      </div>
      <div className="col" style={{ gap: 12, padding: "0 20px 16px" }}>
        <label className="col" style={{ gap: 4 }}>
          <span className="t-l2">상품명 검색</span>
          <input className="inp" type="search" value={q} onChange={(e) => setQ(e.target.value)} maxLength={50} />
        </label>
        {found.kind === "loading" && <span className="t-l2 c-alt">불러오는 중입니다</span>}
        {found.kind === "error" && <span className="t-l2 c-neg">상품을 불러오지 못했습니다. 다시 검색해 주십시오</span>}
        {found.kind === "ok" && found.items.length === 0 && <span className="t-l2 c-alt">검색 결과가 없습니다</span>}
        {found.kind === "ok" && found.items.length > 0 && (
          <div className="au-lt-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>상품</th>
                  <th>가격 · 재고</th>
                  <th aria-label="추가" />
                </tr>
              </thead>
              <tbody>
                {found.items.map((p) => (
                  <tr key={p.id} data-testid="picker-row">
                    <td>{p.name}</td>
                    <td>
                      {won(p.price)} · 재고 {stockOf(p)} {p.status === "SOLD_OUT" && <span className="bdg b-fail">품절</span>}
                    </td>
                    <td>
                      <button className="btn btn-sm" type="button" disabled={taken.has(p.id) || room <= 0 || p.status === "DRAFT"} onClick={() => onAdd(p)}>
                        {taken.has(p.id) ? "추가됨" : "추가"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="modal-f">
        <button className="btn btn-out" type="button" onClick={onClose}>
          닫기
        </button>
      </div>
    </Modal>
  );
}
