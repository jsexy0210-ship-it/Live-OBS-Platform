"use client";

import { useEffect, useState } from "react";
import { api } from "../api";
import { DatePicker } from "../../../components/admin-ui/DatePicker";

// SA-042 회원 상세의 등급 직접 조정(SA-044 수동 조정과 같은 API). 등급을 고르고, 「고정」이면 종료일(없으면 직접 풀 때까지)까지 자동 재산정에서 뺀다.
// API: GET /api/seller/member-grades(등급 목록), PUT /api/seller/member-grades/members/{id} { gradeId, lock, until?, reason? }. 활동 회원만(409 member_not_active).
type Grade = { id: string; displayName: string };

export function MemberGradeAdjust({ memberId, currentGradeId, active, onDone }: { memberId: string; currentGradeId: string | null; active: boolean; onDone: (text: string) => void | Promise<void> }) {
  const [grades, setGrades] = useState<Grade[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [gradeId, setGradeId] = useState(currentGradeId ?? "");
  const [lock, setLock] = useState(false);
  const [until, setUntil] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<{ grades: Grade[] }>("/api/seller/member-grades").then((r) => (r.ok ? setGrades(r.data.grades) : setFailed(true)));
  }, []);
  useEffect(() => setGradeId(currentGradeId ?? ""), [currentGradeId]);

  const apply = async () => {
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/member-grades/members/${memberId}`, {
      method: "PUT",
      body: { gradeId, lock, ...(lock && until ? { until } : {}), ...(lock && reason.trim() ? { reason: reason.trim() } : {}) },
    });
    setBusy(false);
    if (!r.ok) return setError(r.message ?? "등급을 조정하지 못했습니다. 잠시 후 다시 시도해 주십시오");
    setLock(false);
    setUntil("");
    setReason("");
    await onDone(`등급을 조정했습니다${lock ? " · 자동 재산정에서 제외" : ""}`);
  };

  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="member-grade-adjust">
      <h2 className="t-hl1" id="member-grade-adjust">
        등급 조정
      </h2>
      {failed && <span className="t-l2 c-alt">등급 목록을 불러오지 못했습니다. 이 화면을 다시 열어 주십시오.</span>}
      {!active && <span className="t-l2 c-alt">휴면 회원은 등급을 조정할 수 없습니다.</span>}
      {grades && active && (
        <form
          className="col"
          style={{ gap: 12, maxWidth: 480 }}
          onSubmit={(e) => {
            e.preventDefault();
            void apply();
          }}
        >
          <div className="fld">
            <label htmlFor="mg-grade" className="req">
              등급
            </label>
            <select id="mg-grade" className="inp" value={gradeId} disabled={busy} onChange={(e) => setGradeId(e.target.value)}>
              {grades.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.displayName}
                </option>
              ))}
            </select>
          </div>
          <label className="row t-l2" style={{ gap: 8 }}>
            <input className="cbx" type="checkbox" checked={lock} disabled={busy} onChange={(e) => setLock(e.target.checked)} />
            고정 (자동 재산정에서 제외)
          </label>
          {lock && (
            <>
              <div className="fld">
                <label htmlFor="mg-until">고정 종료일</label>
                <DatePicker id="mg-until" value={until} disabled={busy} onChange={(v) => setUntil(v)} />
                <span className="help">비우면 직접 풀 때까지 고정됩니다</span>
              </div>
              <div className="fld">
                <label htmlFor="mg-reason">사유</label>
                <input id="mg-reason" className="inp" maxLength={100} placeholder="예: 방송 단골" value={reason} disabled={busy} onChange={(e) => setReason(e.target.value)} />
              </div>
            </>
          )}
          {error && (
            <div className="msg msg-neg" role="alert">
              <span>{error}</span>
            </div>
          )}
          <div className="row">
            <button className="btn" type="submit" disabled={busy || gradeId === "" || (!lock && gradeId === currentGradeId)}>
              {busy ? "처리 중" : "등급 적용"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
