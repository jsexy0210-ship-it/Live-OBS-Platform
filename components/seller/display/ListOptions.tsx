"use client";

import { useState } from "react";
import { api } from "../api";
import { SORT_LABEL, failText, useDraft, type Display, type ListSort, type Options } from "./types";

// 목록 기본 정렬과 진열 옵션(품절 맨 뒤로·품절 숨기기·방송 상품 앞으로). PUT /api/seller/display/settings, 구매자 목록과 홈 진열에 함께 걸린다.
export function ListOptions({ listSort, options, onSaved, notify }: { listSort: ListSort; options: Options; onSaved: (d: Display) => void; notify: (text: string, neg?: boolean) => void }) {
  const [draft, setDraft, dirty] = useDraft({ listSort, ...options });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await api<Display>("/api/seller/display/settings", { method: "PUT", body: draft });
    setBusy(false);
    if (!r.ok) return notify(failText(r, "진열 옵션을 저장하지 못했습니다. 다시 시도해 주십시오"), true);
    onSaved(r.data);
    notify("진열 옵션을 저장했습니다 · 쇼핑몰에 바로 반영");
  };
  const flag = (key: keyof Options, label: string, help?: string) => (
    <label className="row" style={{ gap: 8 }}>
      <input className="cbx" type="checkbox" checked={draft[key]} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.checked }))} />
      <span>
        {label}
        {help && <span className="t-c1 c-alt"> · {help}</span>}
      </span>
    </label>
  );
  return (
    <section className="card" style={{ padding: 16 }} aria-label="목록 기본 정렬">
      <div className="row between" style={{ gap: 8, flexWrap: "wrap" }}>
        <h2 className="t-h2">목록 기본 정렬</h2>
        <button className="btn" type="button" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? "저장 중" : "정렬 · 옵션 저장"}
        </button>
      </div>
      <div className="col" style={{ gap: 12, marginTop: 8 }}>
        <label className="col" style={{ gap: 4, maxWidth: 320 }}>
          <span className="t-l2">정렬</span>
          <select className="inp" value={draft.listSort} onChange={(e) => setDraft((d) => ({ ...d, listSort: e.target.value as ListSort }))}>
            {(Object.keys(SORT_LABEL) as ListSort[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
          <span className="t-c1 c-alt">구매자가 정렬을 고르지 않았을 때 쓰는 순서입니다.</span>
        </label>
        <div className="col" style={{ gap: 8 }}>
          {flag("soldOutLast", "품절 상품은 맨 뒤로")}
          {flag("hideSoldOut", "품절 상품 숨기기")}
          {flag("liveFirst", "방송 중 상품은 맨 앞으로", "자동 정렬 목록에만 적용")}
        </div>
      </div>
    </section>
  );
}
