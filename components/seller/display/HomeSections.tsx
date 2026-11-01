"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FormRow, FormSection, useConfirm } from "../../admin-ui";
import { useSmartBack, useUrlState } from "../../../lib/client/navigation";
import { api } from "../api";
import { KIND_INFO, MAX_SECTIONS, TITLE_MAX, failText, moved, useDraft, type CategoryNode, type Display, type Kind, type Section } from "./types";

// 홈 진열 영역: 켠 영역만 구매자 홈에 순서대로 보인다. 위·아래로 옮기고 이름·보일 상품 수를 정한 뒤 「영역 저장」으로 통째로 저장한다(PUT /api/seller/display/sections).
const strip = (s: Section): Section => ({ kind: s.kind, categoryId: s.categoryId, title: s.title, visible: s.visible, itemCount: s.itemCount });
type DraftSection = Section & { localKey?: number };
const sectionKey = (s: DraftSection) => s.localKey !== undefined ? `draft:${s.localKey}` : s.id ? `id:${s.id}` : `draft:${s.kind}:${s.categoryId ?? ""}`;
const catName = (cats: CategoryNode[], id: string | null) => {
  for (const p of cats) {
    if (p.id === id) return p.name;
    const c = p.children.find((x) => x.id === id);
    if (c) return `${p.name} › ${c.name}`;
  }
  return "삭제된 카테고리";
};

export function HomeSections({ sections, cats, onSaved, notify }: { sections: Section[]; cats: CategoryNode[]; onSaved: (d: Display) => void; notify: (text: string, neg?: boolean) => void }) {
  const { readOnly } = useConfirm();
  const pathname = usePathname(), params = useSearchParams();
  const [{ section: selectedKey }, setView] = useUrlState({ section: "" });
  const query = new URLSearchParams(params.toString());
  query.delete("section");
  const listHref = `${pathname}${query.size ? `?${query}` : ""}`;
  const detailHref = (key: string) => { const q = new URLSearchParams(query); q.set("section", key); return `${pathname}?${q}`; };
  const back = useSmartBack(listHref);
  const focusKey = useRef<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const server = sections.map((s) => ({ ...strip(s), id: s.id }));
  const [draft, setDraft, dirty] = useDraft<DraftSection[]>(server);
  const nextLocalKey = useRef(0);
  const [busy, setBusy] = useState(false);
  const saveInFlight = useRef(false);
  const [addKind, setAddKind] = useState<Kind | "">("");
  const [addCat, setAddCat] = useState("");
  const matches = draft.filter((s) => sectionKey(s) === selectedKey);
  const selected = matches.length === 1 ? matches[0] : undefined;
  const selectedIndex = selected ? draft.indexOf(selected) : -1;
  const review = selectedKey === "changes" && dirty;
  useEffect(() => {
    if (selectedKey || !focusKey.current) return;
    (document.getElementById(`section-open-${focusKey.current}`) ?? heading.current)?.focus();
    focusKey.current = null;
  }, [selectedKey]);

  const used = new Set(draft.filter((s) => s.kind !== "CATEGORY").map((s) => s.kind));
  const addable = (Object.keys(KIND_INFO) as Kind[]).filter((k) => k === "CATEGORY" || !used.has(k));
  const edit = (patch: Partial<Section>) => setDraft((d) => d.map((s) => sectionKey(s) === selectedKey ? { ...s, ...patch } : s));
  const move = (dir: -1 | 1) => setDraft((d) => { const i = d.findIndex((s) => sectionKey(s) === selectedKey); return i < 0 ? d : moved(d, i, i + dir); });
  const allCats = cats.flatMap((p) => [{ id: p.id, name: p.name }, ...p.children.map((c) => ({ id: c.id, name: `${p.name} › ${c.name}` }))]);
  const canAdd = addKind !== "" && draft.length < MAX_SECTIONS && (addKind !== "CATEGORY" || addCat !== "");

  const add = () => {
    if (addKind === "") return;
    const title = addKind === "CATEGORY" ? (allCats.find((c) => c.id === addCat)?.name.split(" › ").pop() ?? "카테고리") : KIND_INFO[addKind].label;
    const section: DraftSection = { kind: addKind, categoryId: addKind === "CATEGORY" ? addCat : null, title, visible: true, itemCount: 8, localKey: ++nextLocalKey.current };
    setDraft((d) => [...d, section]);
    setAddKind("");
    setAddCat("");
    setView({ section: sectionKey(section) });
  };
  const save = async () => {
    if (saveInFlight.current || readOnly) return;
    saveInFlight.current = true;
    setBusy(true);
    try {
      const r = await api<Display>("/api/seller/display/sections", { method: "PUT", body: { sections: draft.map(strip) } });
      if (!r.ok) return notify(failText(r, "영역을 저장하지 못했습니다. 다시 시도해 주십시오"), true);
      onSaved(r.data);
      notify("홈 진열 영역을 저장했습니다 · 쇼핑몰에 바로 반영");
      setView({ section: "" });
    } finally {
      saveInFlight.current = false;
      setBusy(false);
    }
  };
  const badTitle = draft.some((s) => [...s.title.trim()].length === 0 || [...s.title.trim()].length > TITLE_MAX);

  return (
    <section className="card" style={{ padding: 16 }} aria-label="홈 진열 영역">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="t-h2" ref={heading} tabIndex={-1}>{selectedKey ? "홈 진열 영역 상세" : "홈 진열 영역"}</h2>
        {selectedKey ? <button className="btn btn-out" type="button" onClick={back}>영역 목록</button> : <div className="row" style={{ gap: 8 }}>
          {dirty && <Link className="btn btn-out" href={detailHref("changes")} scroll={false}>변경 내용 상세</Link>}
          {!readOnly && draft.length < MAX_SECTIONS && <Link className="btn btn-out" href={detailHref("new")} scroll={false}>영역 추가</Link>}
        </div>}
        {(selected || review) && <button className="btn" type="button" disabled={!dirty || busy || badTitle || readOnly} onClick={() => void save()}>
          {busy ? "저장 중" : "영역 저장"}
        </button>}
      </div>
      <span className="t-c1 c-alt">켠 영역만 홈에 순서대로 보입니다 · 상품이 하나도 없는 영역은 홈에서 빠집니다 · 영역은 {MAX_SECTIONS}개까지, 카테고리 말고는 종류마다 하나입니다.</span>
      {!selectedKey && <div className="au-lt-wrap">
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
              <tr key={sectionKey(s)} data-testid="section-row">
                <td>{s.title}</td>
                <td>{s.kind === "CATEGORY" ? `카테고리 · ${catName(cats, s.categoryId)}` : KIND_INFO[s.kind].basis}</td>
                <td>{s.itemCount}</td>
                <td>{s.visible ? "보임" : "안 보임"}</td>
                <td>{i + 1}</td>
                <td>
                  <Link id={`section-open-${sectionKey(s)}`} className="btn btn-sm btn-out" href={detailHref(sectionKey(s))} scroll={false} onClick={() => { focusKey.current = sectionKey(s); }}>상세</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>}
      {selected && <div data-testid="section-detail">
        <FormSection title={selected.title}>
          <FormRow label="영역 이름"><input className="inp" aria-label={`${KIND_INFO[selected.kind].label} 영역 이름`} value={selected.title} maxLength={TITLE_MAX + 10} disabled={busy || readOnly} onChange={(e) => edit({ title: e.target.value })} /></FormRow>
          <FormRow label="보일 상품 수"><input className="inp" type="number" min={1} max={20} aria-label={`${selected.title} 보일 상품 수`} value={selected.itemCount} disabled={busy || readOnly} onChange={(e) => edit({ itemCount: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })} /></FormRow>
          <FormRow label="홈에 표시"><label className="chk"><input type="checkbox" aria-label={`${selected.title} 홈에 표시`} checked={selected.visible} disabled={busy || readOnly} onChange={(e) => edit({ visible: e.target.checked })} />홈에 표시</label></FormRow>
          <FormRow label="순서"><button className="btn btn-sm btn-out" type="button" aria-label={`${selected.title} 위로`} disabled={busy || readOnly || selectedIndex === 0} onClick={() => move(-1)}>▲</button><button className="btn btn-sm btn-out" type="button" aria-label={`${selected.title} 아래로`} disabled={busy || readOnly || selectedIndex === draft.length - 1} onClick={() => move(1)}>▼</button></FormRow>
        </FormSection>
        <button className="btn btn-out" type="button" disabled={busy || readOnly} onClick={() => { setDraft((d) => d.filter((s) => sectionKey(s) !== selectedKey)); setView({ section: "changes" }); }}>영역 빼기</button>
      </div>}
      {review && <p>홈에 표시할 영역은 {draft.length}개예요. 영역 저장을 누르면 지금까지 바꾼 내용이 함께 반영돼요.</p>}
      {selectedKey && !selected && !review && selectedKey !== "new" && <p role="status">이 영역을 찾을 수 없어요. 영역 목록에서 다시 선택해 주세요.</p>}
      {badTitle && <span className="t-c1 c-neg">영역 이름은 1~{TITLE_MAX}자로 입력해 주십시오</span>}
      {selectedKey === "new" && <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
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
        <button className="btn btn-sm btn-out" type="button" disabled={!canAdd || readOnly} onClick={add}>
          추가
        </button>
        {draft.length >= MAX_SECTIONS && <span className="t-c1 c-alt">영역은 {MAX_SECTIONS}개까지 넣을 수 있습니다</span>}
      </div>}
    </section>
  );
}
