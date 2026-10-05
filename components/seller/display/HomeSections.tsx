"use client";

import { useState } from "react";
import { api } from "../api";
import { KIND_INFO, MAX_SECTIONS, TITLE_MAX, failText, moved, useDraft, type CategoryNode, type Display, type Kind, type Section } from "./types";

// 홈 진열 영역: 켠 영역만 구매자 홈에 순서대로 보인다. 위·아래로 옮기고 이름·보일 상품 수를 정한 뒤 「영역 저장」으로 통째로 저장한다(PUT /api/seller/display/sections).
const strip = (s: Section): Section => ({ kind: s.kind, categoryId: s.categoryId, title: s.title, visible: s.visible, itemCount: s.itemCount });
const catName = (cats: CategoryNode[], id: string | null) => {
  for (const p of cats) {
    if (p.id === id) return p.name;
    const c = p.children.find((x) => x.id === id);
    if (c) return `${p.name} › ${c.name}`;
  }
  return "삭제된 카테고리";
};

export function HomeSections({ sections, cats, onSaved, notify }: { sections: Section[]; cats: CategoryNode[]; onSaved: (d: Display) => void; notify: (text: string, neg?: boolean) => void }) {
  const server = sections.map(strip);
  const [draft, setDraft, dirty] = useDraft(server);
  const [busy, setBusy] = useState(false);
  const [addKind, setAddKind] = useState<Kind | "">("");
  const [addCat, setAddCat] = useState("");

  const used = new Set(draft.filter((s) => s.kind !== "CATEGORY").map((s) => s.kind));
  const addable = (Object.keys(KIND_INFO) as Kind[]).filter((k) => k === "CATEGORY" || !used.has(k));
  const edit = (i: number, patch: Partial<Section>) => setDraft((d) => d.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const allCats = cats.flatMap((p) => [{ id: p.id, name: p.name }, ...p.children.map((c) => ({ id: c.id, name: `${p.name} › ${c.name}` }))]);
  const canAdd = addKind !== "" && draft.length < MAX_SECTIONS && (addKind !== "CATEGORY" || addCat !== "");

  const add = () => {
    if (addKind === "") return;
    const title = addKind === "CATEGORY" ? (allCats.find((c) => c.id === addCat)?.name.split(" › ").pop() ?? "카테고리") : KIND_INFO[addKind].label;
    setDraft((d) => [...d, { kind: addKind, categoryId: addKind === "CATEGORY" ? addCat : null, title, visible: true, itemCount: 8 }]);
    setAddKind("");
    setAddCat("");
  };
  const save = async () => {
    setBusy(true);
    const r = await api<Display>("/api/seller/display/sections", { method: "PUT", body: { sections: draft } });
    setBusy(false);
    if (!r.ok) return notify(failText(r, "영역을 저장하지 못했습니다. 다시 시도해 주십시오"), true);
    onSaved(r.data);
    notify("홈 진열 영역을 저장했습니다 · 쇼핑몰에 바로 반영");
  };
  const badTitle = draft.some((s) => [...s.title.trim()].length === 0 || [...s.title.trim()].length > TITLE_MAX);

  return (
    <section className="card" style={{ padding: 16 }} aria-label="홈 진열 영역">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="t-h2">홈 진열 영역</h2>
        <button className="btn" type="button" disabled={!dirty || busy || badTitle} onClick={() => void save()}>
          {busy ? "저장 중" : "영역 저장"}
        </button>
      </div>
      <span className="t-c1 c-alt">켠 영역만 홈에 순서대로 보입니다 · 상품이 하나도 없는 영역은 홈에서 빠집니다 · 영역은 {MAX_SECTIONS}개까지, 카테고리 말고는 종류마다 하나입니다.</span>
      <div className="au-lt-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>영역 이름</th>
              <th>기준</th>
              <th>보일 상품 수</th>
              <th>홈에 표시</th>
              <th>순서</th>
              <th aria-label="관리" />
            </tr>
          </thead>
          <tbody>
            {draft.map((s, i) => (
              <tr key={`${s.kind}-${s.categoryId ?? ""}-${i}`} data-testid="section-row">
                <td>
                  <input className="inp inp-sm" type="text" aria-label={`${KIND_INFO[s.kind].label} 영역 이름`} value={s.title} maxLength={TITLE_MAX + 10} onChange={(e) => edit(i, { title: e.target.value })} />
                </td>
                <td>{s.kind === "CATEGORY" ? `카테고리 · ${catName(cats, s.categoryId)}` : KIND_INFO[s.kind].basis}</td>
                <td>
                  <input className="inp inp-sm" type="number" min={1} max={20} aria-label={`${s.title} 보일 상품 수`} value={s.itemCount} onChange={(e) => edit(i, { itemCount: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })} />
                </td>
                <td>
                  <input className="cbx" type="checkbox" aria-label={`${s.title} 홈에 표시`} checked={s.visible} onChange={(e) => edit(i, { visible: e.target.checked })} />
                </td>
                <td>
                  <span className="row" style={{ gap: 2 }}>
                    <button className="btn btn-sm btn-out" type="button" aria-label={`${s.title} 위로`} disabled={i === 0} onClick={() => setDraft((d) => moved(d, i, i - 1))}>
                      ▲
                    </button>
                    <button className="btn btn-sm btn-out" type="button" aria-label={`${s.title} 아래로`} disabled={i === draft.length - 1} onClick={() => setDraft((d) => moved(d, i, i + 1))}>
                      ▼
                    </button>
                  </span>
                </td>
                <td>
                  <button className="btn btn-sm btn-out" type="button" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}>
                    영역 빼기
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {badTitle && <span className="t-c1 c-neg">영역 이름은 1~{TITLE_MAX}자로 입력해 주십시오</span>}
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
        <label className="row" style={{ gap: 6 }}>
          <span className="t-l2" style={{ whiteSpace: "nowrap" }}>영역 추가</span>
          <select className="inp inp-sm" value={addKind} onChange={(e) => setAddKind(e.target.value as Kind | "")} disabled={draft.length >= MAX_SECTIONS}>
            <option value="">종류 선택</option>
            {addable.map((k) => (
              <option key={k} value={k}>
                {KIND_INFO[k].label}
              </option>
            ))}
          </select>
        </label>
        {addKind === "CATEGORY" && (
          <select className="inp inp-sm" aria-label="카테고리" value={addCat} onChange={(e) => setAddCat(e.target.value)}>
            <option value="">카테고리 선택</option>
            {allCats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn btn-sm btn-out" type="button" disabled={!canAdd} onClick={add}>
          추가
        </button>
        {draft.length >= MAX_SECTIONS && <span className="t-c1 c-alt">영역은 {MAX_SECTIONS}개까지 넣을 수 있습니다</span>}
      </div>
    </section>
  );
}
