"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FormRow, FormSection, useConfirm } from "../../admin-ui";
import { useSmartBack, useUrlState } from "../../../lib/client/navigation";
import { api } from "../api";
import { KIND_INFO, failText, moved, useDraft, type CategoryNode, type Display, type Kind, type Section } from "./types";

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

// 정본 SA-016: 영역은 6종 고정(방송 상품 · 추천 · 신상품 · 베스트 · 할인 중 · 명예의 전당). 방송 상품은 맨 앞, 명예의 전당은 맨 뒤에 두고 가운데 넷만 순서를 바꿉니다.
// 이미 저장된 카테고리 영역은 새로 만들거나 이름을 바꿀 수 없고(읽기 전용), 저장할 때 그대로 되돌려 보냅니다(지워지지 않게).
const FIXED_KINDS: Kind[] = ["LIVE", "RECOMMENDED", "NEW", "BEST", "SALE", "HALL_OF_FAME"];
const MOVABLE: Kind[] = ["RECOMMENDED", "NEW", "BEST", "SALE"];
const FIXED_HINT: Partial<Record<Kind, string>> = { LIVE: "자동", HALL_OF_FAME: "자동" };
const DEFAULT_BASIS: Partial<Record<Kind, string>> = { LIVE: "방송 중 · 예정 방송에 묶인 상품 · 자동", HALL_OF_FAME: "HIT 카드 · 쇼핑몰 정보와 연동" };
// 저장·화면 순서: 방송 상품 → (가운데 넷, 초안 순서) → 카테고리 영역(저장된 것) → 명예의 전당
const normalize = (list: DraftSection[]): DraftSection[] => [
  ...list.filter((s) => s.kind === "LIVE"),
  ...list.filter((s) => MOVABLE.includes(s.kind)),
  ...list.filter((s) => s.kind === "CATEGORY"),
  ...list.filter((s) => s.kind === "HALL_OF_FAME"),
];

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
  const matches = draft.filter((s) => sectionKey(s) === selectedKey);
  const selected = matches.length === 1 ? matches[0] : undefined;
  const selectedIndex = selected ? draft.indexOf(selected) : -1;
  const review = selectedKey === "changes" && dirty;
  useEffect(() => {
    if (selectedKey || !focusKey.current) return;
    (document.getElementById(`section-open-${focusKey.current}`) ?? heading.current)?.focus();
    focusKey.current = null;
  }, [selectedKey]);

  const edit = (patch: Partial<Section>) => setDraft((d) => d.map((s) => sectionKey(s) === selectedKey ? { ...s, ...patch } : s));
  // 순서는 가운데 넷끼리만 바꾼다(화면 순서 = 저장 순서)
  const move = (dir: -1 | 1) => setDraft((d) => {
    const order = normalize(d);
    const movable = order.filter((s) => MOVABLE.includes(s.kind));
    const i = movable.findIndex((s) => sectionKey(s) === selectedKey);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= movable.length) return d;
    const next = moved(movable, i, j);
    let k = 0;
    return order.map((s) => (MOVABLE.includes(s.kind) ? next[k++] : s));
  });

  // 표 행: 6종 고정. 아직 저장된 적 없는 종류는 「안 보임」으로 보이고, 상세를 열면 그때 초안에 들어가며(꺼진 채), 「홈에 보이기」를 눌러야 켜집니다.
  const rows = FIXED_KINDS.flatMap((kind) => {
    const found = draft.filter((s) => s.kind === kind);
    return found.length > 0 ? normalize(found).concat() : [{ kind, categoryId: null, title: KIND_INFO[kind].label, visible: false, itemCount: 8, absent: true } as DraftSection & { absent: true }];
  });
  const ordered = [
    ...rows.filter((s) => s.kind === "LIVE"),
    ...normalize(draft).filter((s) => MOVABLE.includes(s.kind)),
    ...rows.filter((s) => MOVABLE.includes(s.kind) && (s as { absent?: boolean }).absent),
    ...rows.filter((s) => s.kind === "HALL_OF_FAME"),
  ];
  const categorySections = draft.filter((s) => s.kind === "CATEGORY");
  const openRow = (kind: Kind, present: DraftSection | undefined) => {
    if (present) return setView({ section: sectionKey(present) });
    const created: DraftSection = { kind, categoryId: null, title: KIND_INFO[kind].label, visible: false, itemCount: 8, localKey: ++nextLocalKey.current };
    setDraft((d) => [...d, created]);
    setView({ section: sectionKey(created) });
  };

  const save = async () => {
    if (saveInFlight.current || readOnly) return;
    saveInFlight.current = true;
    setBusy(true);
    try {
      const r = await api<Display>("/api/seller/display/sections", { method: "PUT", body: { sections: normalize(draft).map(strip) } });
      if (!r.ok) return notify(failText(r, "영역을 저장하지 못했습니다. 다시 시도해 주십시오"), true);
      onSaved(r.data);
      notify("홈 진열 영역을 저장했습니다 · 쇼핑몰에 바로 반영");
      setView({ section: "" });
    } finally {
      saveInFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="card" style={{ padding: 16 }} aria-label="홈 진열 영역">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="t-h2" ref={heading} tabIndex={-1}>{selectedKey ? "홈 진열 영역 상세" : "홈 진열 영역"}</h2>
        {selectedKey ? <button className="btn btn-out" type="button" onClick={back}>영역 목록</button> : <div className="row" style={{ gap: 8 }}>
          {dirty && <Link className="btn btn-out" href={detailHref("changes")} scroll={false}>변경 내용 상세</Link>}
        </div>}
        {(selected || review) && <button className="btn" type="button" disabled={!dirty || busy || readOnly} onClick={() => void save()}>
          {busy ? "저장 중" : "영역 저장"}
        </button>}
      </div>
      <span className="t-c1 c-alt">켠 영역만 홈에 순서대로 표시 · 상품이 하나도 없는 영역은 홈에서 빠집니다 · 순서는 추천 · 신상품 · 베스트 · 할인 중만 바꿀 수 있습니다</span>
      {!selectedKey && <div className="au-lt-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>영역</th>
              <th>기준</th>
              <th>상품</th>
              <th>홈에 표시</th>
              <th aria-label="관리" />
            </tr>
          </thead>
          <tbody>
            {ordered.map((s) => {
              const absent = (s as { absent?: boolean }).absent === true;
              const present = absent ? undefined : s;
              const key = sectionKey(s);
              const label = KIND_INFO[s.kind].label;
              return (
                <tr key={`${s.kind}:${absent ? "absent" : key}`} data-testid="section-row">
                  <td>
                    <b>{s.kind === "LIVE" ? "방송 상품 (자동)" : label}</b>
                    {!absent && s.title !== label && <div className="t-c1 c-alt">홈에서 쓰는 이름: {s.title}</div>}
                  </td>
                  <td>{DEFAULT_BASIS[s.kind] ?? KIND_INFO[s.kind].basis}</td>
                  <td>{s.kind === "HALL_OF_FAME" || absent ? "—" : `${s.itemCount}개`}</td>
                  <td>
                    {s.visible ? "보임" : "안 보임"}
                    {FIXED_HINT[s.kind] && <span className="t-c1 c-alt"> · {FIXED_HINT[s.kind]}</span>}
                  </td>
                  <td>
                    <Link id={`section-open-${key}`} className="btn btn-sm btn-out" href={detailHref(key)} scroll={false} onClick={(e) => { if (!present) { e.preventDefault(); openRow(s.kind, undefined); } else focusKey.current = key; }}>상세</Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>}
      {!selectedKey && categorySections.length > 0 && <div data-testid="category-sections">
        <span className="t-c1 c-alt">저장된 카테고리 영역 {categorySections.length}개 · 새로 만들거나 이름을 바꿀 수 없고, 저장해도 그대로 유지됩니다</span>
        <ul>
          {categorySections.map((s) => (
            <li key={sectionKey(s)} data-testid="category-section-row">{s.title} · {catName(cats, s.categoryId)} · {s.visible ? "보임" : "안 보임"} · {s.itemCount}개</li>
          ))}
        </ul>
      </div>}
      {selected && <div data-testid="section-detail">
        <FormSection title={KIND_INFO[selected.kind].label}>
          <FormRow label="영역"><span>{KIND_INFO[selected.kind].label}{selected.title !== KIND_INFO[selected.kind].label ? ` · 홈에서 쓰는 이름: ${selected.title}` : ""}</span></FormRow>
          <FormRow label="보일 상품 수"><input className="inp" type="number" min={1} max={20} aria-label={`${selected.title} 보일 상품 수`} value={selected.itemCount} disabled={busy || readOnly || selected.kind === "HALL_OF_FAME"} onChange={(e) => edit({ itemCount: Math.min(20, Math.max(1, Number(e.target.value) || 1)) })} /></FormRow>
          <FormRow label="홈에 표시"><label className="chk"><input type="checkbox" aria-label={`${selected.title} 홈에 표시`} checked={selected.visible} disabled={busy || readOnly} onChange={(e) => edit({ visible: e.target.checked })} />홈에 보이기</label></FormRow>
          {MOVABLE.includes(selected.kind) && <FormRow label="순서"><button className="btn btn-sm btn-out" type="button" aria-label={`${selected.title} 위로`} disabled={busy || readOnly || selectedIndex < 0 || normalize(draft).filter((s) => MOVABLE.includes(s.kind))[0] === selected} onClick={() => move(-1)}>▲</button><button className="btn btn-sm btn-out" type="button" aria-label={`${selected.title} 아래로`} disabled={busy || readOnly || normalize(draft).filter((s) => MOVABLE.includes(s.kind)).slice(-1)[0] === selected} onClick={() => move(1)}>▼</button></FormRow>}
        </FormSection>
      </div>}
      {review && <p>저장하면 지금까지 바꾼 내용이 함께 홈에 반영됩니다.</p>}
      {selectedKey && !selected && !review && <p role="status">이 영역을 찾을 수 없습니다. 영역 목록에서 다시 선택해 주십시오.</p>}
    </section>
  );
}
