"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { memberDay } from "./types";

// SA-042 회원 상세의 회원 메모(회원마다 1건, 덮어쓰기). 빈 글로 저장하면 메모가 지워진다. 1,000자까지.
// API: GET·PUT /api/seller/members/{id}/memo (회원·적립금 권한). 로그 추적에는 본문 없이 글자 수만 남는다.
type Memo = { body: string; createdAt: string; updatedAt: string; updatedBy: { name: string } | null };
const MAX = 1000;

export function MemberMemo({ memberId, onSaved }: { memberId: string; onSaved: (text: string) => void }) {
  const [saved, setSaved] = useState<Memo | null | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ memo: Memo | null }>(`/api/seller/members/${memberId}/memo`);
    if (!r.ok) return setFailed(true);
    setFailed(false);
    setSaved(r.data.memo);
    setText(r.data.memo?.body ?? "");
  }, [memberId]);
  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await api<{ memo: Memo | null }>(`/api/seller/members/${memberId}/memo`, { method: "PUT", body: { body: text } });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? "메모를 저장하지 못했습니다. 잠시 후 다시 시도해 주십시오");
    setSaved(r.data.memo);
    setText(r.data.memo?.body ?? "");
    onSaved(r.data.memo ? "메모를 저장했습니다" : "메모를 지웠습니다");
  };

  const dirty = saved !== undefined && text !== (saved?.body ?? "");

  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="member-memo-title">
      <h2 className="t-hl1" id="member-memo-title">
        회원 메모
      </h2>
      {failed && (
        <div className="row" style={{ gap: 8 }}>
          <span className="t-l2 c-alt">메모를 불러오지 못했습니다.</span>
          <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
            다시 시도
          </button>
        </div>
      )}
      {saved !== undefined && (
        <form
          className="col"
          style={{ gap: 10, maxWidth: 640 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) void save();
          }}
        >
          <div className="fld">
            <label htmlFor="member-memo" className="lbl">
              메모
            </label>
            <textarea id="member-memo" className="inp" style={{ height: 120, padding: "10px 12px" }} maxLength={MAX} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
            <span className="help num">
              {text.length}/{MAX}자 · 개인정보는 적지 마십시오 · 비우고 저장하면 메모가 지워집니다
            </span>
          </div>
          {saved && (
            <span className="t-c1 c-alt" data-testid="member-memo-meta">
              마지막 저장 {memberDay(saved.updatedAt)}
              {saved.updatedBy ? ` · ${saved.updatedBy.name}` : ""}
            </span>
          )}
          {error && (
            <div className="msg msg-neg" role="alert">
              <span>{error}</span>
            </div>
          )}
          <div className="row">
            <button className="btn" type="submit" disabled={busy || !dirty}>
              {busy ? "저장 중" : "메모 저장"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
