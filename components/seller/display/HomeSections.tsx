"use client";

import { useRef } from "react";
import { useConfirm } from "../../admin-ui";
import { api } from "../api";
import { KIND_INFO, MAX_SECTIONS, failText, moved, useDraft, useTrackSave, type CategoryNode, type Display, type Kind, type Section, type Track } from "./types";

// 홈 진열 영역: 켠 영역만 구매자 홈에 순서대로 보인다. 표 안 ▲▼로 순서를 바꾸고 「보일 상품 수」 · 「홈에 표시」를 정한 뒤 화면 아래 「저장」으로 통째로 저장한다(PUT /api/seller/display/sections).
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

export function HomeSections({ sections, cats, onSaved, notify, track, recommendedCount }: { sections: Section[]; cats: CategoryNode[]; onSaved: (d: Display) => void; notify: (text: string, neg?: boolean) => void; track: Track; recommendedCount: number }) {
  const { readOnly } = useConfirm();
  const server = sections.map((s) => ({ ...strip(s), id: s.id }));
  const [draft, setDraft, dirty] = useDraft<DraftSection[]>(server);
  const nextLocalKey = useRef(0);
  const saveInFlight = useRef(false);
  const setCount = (key: string, n: number) => setDraft((d) => d.map((s) => sectionKey(s) === key ? { ...s, itemCount: Math.min(20, Math.max(1, n || 1)) } : s));
  // 순서는 가운데 넷끼리만 바꾼다(화면 순서 = 저장 순서)
  const move = (key: string, dir: -1 | 1) => setDraft((d) => {
    const order = normalize(d);
    const movable = order.filter((s) => MOVABLE.includes(s.kind));
    const i = movable.findIndex((s) => sectionKey(s) === key);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= movable.length) return d;
    const next = moved(movable, i, j);
    let k = 0;
    return order.map((s) => (MOVABLE.includes(s.kind) ? next[k++] : s));
  });

  // 표 행: 6종 고정. 아직 저장된 적 없는 종류는 「안 보임」으로 보이고, 「홈에 표시」를 켜면 그때 초안에 들어갑니다.
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
  const presentMovable = normalize(draft).filter((s) => MOVABLE.includes(s.kind));
  const categorySections = draft.filter((s) => s.kind === "CATEGORY");
  const toggleVisible = (kind: Kind, present: DraftSection | undefined, checked: boolean) => {
    if (present) return setDraft((d) => d.map((s) => sectionKey(s) === sectionKey(present) ? { ...s, visible: checked } : s));
    if (draft.length >= MAX_SECTIONS) return notify(`영역은 ${MAX_SECTIONS}개까지 넣을 수 있습니다 · 저장된 카테고리 영역이 많아 더 켤 수 없습니다`, true);
    setDraft((d) => [...d, { kind, categoryId: null, title: KIND_INFO[kind].label, visible: checked, itemCount: 8, localKey: ++nextLocalKey.current }]);
  };

  const save = async () => {
    if (saveInFlight.current || readOnly) return false;
    saveInFlight.current = true;
    try {
      const r = await api<Display>("/api/seller/display/sections", { method: "PUT", body: { sections: normalize(draft).map(strip) } });
      if (!r.ok) {
        notify(failText(r, "영역을 저장하지 못했습니다. 다시 시도해 주십시오"), true);
        return false;
      }
      onSaved(r.data);
      return true;
    } finally {
      saveInFlight.current = false;
    }
  };
  useTrackSave(track, "sections", dirty, save);

  return (
    <section className="card" style={{ padding: 16 }} aria-label="홈 진열 영역">
      <h2 className="t-h2">홈 진열 영역</h2>
      <span className="t-c1 c-alt">켠 영역만 홈에 순서대로 표시 · ▲▼로 순서 변경 · 「저장」 1회로 반영 · 「보일 상품 수」는 영역마다 1~20 · 상품이 하나도 없는 영역은 홈에서 빠집니다</span>
      <div className="au-lt-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>순서</th>
              <th>영역</th>
              <th>기준</th>
              <th>보일 상품 수</th>
              <th>홈에 표시</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((s, index) => {
              const absent = (s as { absent?: boolean }).absent === true;
              const present = absent ? undefined : s;
              const key = sectionKey(s);
              const label = KIND_INFO[s.kind].label;
              const movable = MOVABLE.includes(s.kind);
              const first = presentMovable[0] && sectionKey(presentMovable[0]) === key;
              const last = presentMovable.length > 0 && sectionKey(presentMovable[presentMovable.length - 1]) === key;
              return (
                <tr key={`${s.kind}:${absent ? "absent" : key}`} data-testid="section-row">
                  <td>
                    {s.kind === "LIVE" ? <span className="num">{index + 1} · 맨 앞 고정</span> : s.kind === "HALL_OF_FAME" ? <span className="num">{index + 1} · 맨 뒤 고정</span> : (
                      <span className="row" style={{ gap: 4, alignItems: "center" }}>
                        <span className="num">{index + 1}</span>
                        <button className="btn btn-sm btn-out" type="button" aria-label={`${label} 위로`} disabled={readOnly || !movable || absent || first} onClick={() => move(key, -1)}>▲</button>
                        <button className="btn btn-sm btn-out" type="button" aria-label={`${label} 아래로`} disabled={readOnly || !movable || absent || last} onClick={() => move(key, 1)}>▼</button>
                      </span>
                    )}
                  </td>
                  <td>
                    <b>{s.kind === "LIVE" ? "방송 상품 (자동)" : label}</b>
                    {!absent && s.title !== label && <div className="t-c1 c-alt">홈에서 쓰는 이름: {s.title}</div>}
                  </td>
                  <td>{DEFAULT_BASIS[s.kind] ?? KIND_INFO[s.kind].basis}</td>
                  <td>
                    {s.kind === "HALL_OF_FAME" ? "—" : s.kind === "RECOMMENDED" ? `${recommendedCount}개 · 최대 20개` : (
                      <input className="inp inp-sm" style={{ width: 80 }} type="number" min={1} max={20} aria-label={`${label} 보일 상품 수`} value={s.itemCount} disabled={readOnly || absent} onChange={(e) => setCount(key, Number(e.target.value))} />
                    )}
                  </td>
                  <td>
                    <label className="chk"><input type="checkbox" aria-label={`${label} 홈에 표시`} checked={s.visible} disabled={readOnly} onChange={(e) => toggleVisible(s.kind, present, e.target.checked)} />{s.visible ? "보임" : "안 보임"}</label>
                    {FIXED_HINT[s.kind] && <span className="t-c1 c-alt"> · {FIXED_HINT[s.kind]}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {categorySections.length > 0 && <div data-testid="category-sections">
        <span className="t-c1 c-alt">저장된 카테고리 영역 {categorySections.length}개 · 새로 만들거나 이름을 바꿀 수 없고, 저장해도 그대로 유지됩니다</span>
        <ul>
          {categorySections.map((s) => (
            <li key={sectionKey(s)} data-testid="category-section-row">{s.title} · {catName(cats, s.categoryId)} · {s.visible ? "보임" : "안 보임"} · {s.itemCount}개</li>
          ))}
        </ul>
      </div>}
    </section>
  );
}
