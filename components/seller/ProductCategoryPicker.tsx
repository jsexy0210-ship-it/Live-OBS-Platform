"use client";

import "./ProductCategory.css";
import { useState } from "react";
import { Modal } from "../admin-ui/Modal";

// 상품 카테고리 다중 선택(SA-012): 고른 카테고리를 칩(「대분류 › 하위」 ×)으로 보이고, 「카테고리 고르기」 창에서 대분류·하위를 체크로 고른다(상품당 최대 10개).
// 저장은 부모가 한다(제어형): ids를 그리고, 바뀌면 onChange로 알린다. 서버는 GET·PUT /api/seller/products/{id}/categories(0~10개, 통째로 바꿈).
export type CategoryNode = { id: string; name: string; visible?: boolean; children: CategoryNode[] };
export const CATEGORY_MAX = 10;

// 「대분류 › 하위」 표기. 트리에 없는 id(지운 카테고리)는 null
export function categoryLabel(tree: CategoryNode[], id: string): string | null {
  for (const top of tree) {
    if (top.id === id) return top.name;
    const child = top.children.find((c) => c.id === id);
    if (child) return `${top.name} › ${child.name}`;
  }
  return null;
}

// 선택 상자용 평평한 목록: 대분류 다음에 그 하위(「게임」「게임 › 포켓몬」…)
export function categoryOptions(tree: CategoryNode[]): { id: string; label: string }[] {
  return tree.flatMap((top) => [
    { id: top.id, label: `${top.name}${top.visible === false ? " (숨김)" : ""}` },
    ...top.children.map((c) => ({ id: c.id, label: `${top.name} › ${c.name}${c.visible === false || top.visible === false ? " (숨김)" : ""}` })),
  ]);
}

export default function ProductCategoryPicker({ tree, ids, disabled, onChange }: { tree: CategoryNode[]; ids: string[]; disabled?: boolean; onChange: (ids: string[]) => void }) {
  const [open, setOpen] = useState(false);
  // 창 안에서 고르는 중인 값(적용을 눌러야 바뀐다)
  const [draft, setDraft] = useState<string[]>(ids);
  const known = ids.filter((id) => categoryLabel(tree, id) !== null);

  const openPicker = () => {
    setDraft(known);
    setOpen(true);
  };
  const toggle = (id: string) => setDraft((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= CATEGORY_MAX ? cur : [...cur, id]));
  const full = draft.length >= CATEGORY_MAX;

  return (
    <div className="col" style={{ gap: 8, width: "100%" }}>
      <div className="pc-chips" data-testid="category-chips">
        {known.length === 0 && <span className="t-l2 c-alt">고른 카테고리가 없습니다</span>}
        {known.map((id) => (
          <span key={id} className="pc-chip" data-testid="category-chip">
            {categoryLabel(tree, id)}
            <button type="button" className="pc-x" aria-label={`${categoryLabel(tree, id)} 지우기`} disabled={disabled} onClick={() => onChange(known.filter((x) => x !== id))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <button className="btn btn-sm btn-out" type="button" disabled={disabled || tree.length === 0} onClick={openPicker}>
          카테고리 고르기
        </button>
        <span className="t-c1 c-alt num" data-testid="category-count">
          {known.length} / {CATEGORY_MAX} · 대분류 · 하위 어느 쪽이든 고를 수 있습니다 · 상품당 최대 {CATEGORY_MAX}개
        </span>
      </div>
      {open && (
        <Modal labelId="cat-picker-title" className="pc-modal" onClose={() => setOpen(false)}>
          <div className="modal-h">
            <h2 className="modal-t" id="cat-picker-title">
              카테고리 고르기 (최대 {CATEGORY_MAX}개)
            </h2>
          </div>
          <div className="pc-tree" role="group" aria-label="카테고리">
            {tree.map((top) => (
              <div key={top.id} className="pc-group">
                <label className="chk">
                  <input className="cbx" type="checkbox" checked={draft.includes(top.id)} disabled={!draft.includes(top.id) && full} onChange={() => toggle(top.id)} />
                  {top.name}
                  {top.visible === false && <span className="c-alt"> (숨김)</span>}
                </label>
                {top.children.map((c) => (
                  <label key={c.id} className="chk pc-child">
                    <input className="cbx" type="checkbox" checked={draft.includes(c.id)} disabled={!draft.includes(c.id) && full} onChange={() => toggle(c.id)} />
                    {c.name}
                    {c.visible === false && <span className="c-alt"> (숨김)</span>}
                  </label>
                ))}
              </div>
            ))}
          </div>
          <span className="t-c1 c-alt num" data-testid="category-draft-count">
            {draft.length} / {CATEGORY_MAX} · 대분류 자체도 고를 수 있습니다 · 숨긴 카테고리에 넣은 상품은 「전체」와 다른 카테고리에서만 보입니다
          </span>
          {full && (
            <span className="msg msg-cau" role="status" style={{ display: "block" }}>
              카테고리는 상품당 {CATEGORY_MAX}개까지 고를 수 있습니다 · 11번째는 선택되지 않습니다
            </span>
          )}
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setOpen(false)}>
              취소
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                onChange(draft);
                setOpen(false);
              }}
            >
              적용
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
