"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";

// SA-140 도우미. API: GET·POST /api/seller/assistant. 플랫폼 사용법 질문·답변 전용(답만 하고 실행하지 않음).
// 준비 중(꺼짐·키 없음)이면 입력 대신 안내만 보인다. 답하지 못하면 문의하기(SA-113)로 이어 준다.
type Status = { available: boolean; questionMax: number; remainingToday: number };
type Turn = { q: string; a: string; answered: boolean };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; s: Status };

export default function AssistantPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api<Status>("/api/seller/assistant");
    setState(r.ok ? { kind: "ok", s: r.data } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    const r = await api<{ answered: boolean; answer: string; remainingToday: number }>("/api/seller/assistant", { method: "POST", body: { question: q } });
    setBusy(false);
    if (r.ok) {
      setTurns((t) => [...t, { q, a: r.data.answer, answered: r.data.answered }]);
      setQuestion("");
      setState((s) => (s.kind === "ok" ? { kind: "ok", s: { ...s.s, remainingToday: r.data.remainingToday } } : s));
    } else {
      setError(r.message ?? "도우미가 답하지 못했습니다. 잠시 뒤 다시 시도해 주십시오");
      if (r.error === "unavailable") void load();
    }
  };

  const s = state.kind === "ok" ? state.s : null;
  return (
    <>
      <Topbar crumb="도우미" />
      <main className="main">
        <PageHead title="도우미" />
        {!s ? (
          <div className="card">{state.kind === "loading" ? <LoadingRows rows={3} /> : <ErrorState title="도우미를 불러오지 못했습니다" onRetry={() => void load()} />}</div>
        ) : !s.available ? (
          <div className="card">
            <div className="st">
              <span className="t">도우미는 준비 중입니다</span>
              <span className="d">사용법이 막히면 문의하기로 남겨 주십시오.</span>
            </div>
          </div>
        ) : (
          <div className="col" style={{ gap: 16 }}>
            <section className="card pad-l col" style={{ gap: 12 }} aria-label="질문하기">
              <span className="t-c1 c-alt">플랫폼 사용법만 답합니다. 주문·설정 변경은 하지 않으며, 개인정보는 입력하지 마십시오. 오늘 남은 질문 {s.remainingToday}회</span>
              <form className="col" style={{ gap: 10 }} onSubmit={send}>
                <textarea className="inp" rows={3} maxLength={s.questionMax} value={question} onChange={(e) => setQuestion(e.target.value)} disabled={busy || s.remainingToday === 0} placeholder="예: 주문 취소 방법" aria-label="질문" />
                <div className="row" style={{ gap: 12 }}>
                  <button className="btn btn-pri" type="submit" disabled={busy || s.remainingToday === 0 || question.trim() === ""}>
                    {busy ? "답변 중" : "질문하기"}
                  </button>
                  <span className="t-c1 c-alt">{[...question].length} / {s.questionMax}자</span>
                </div>
                {error && (
                  <span className="t-c1" role="alert" style={{ color: "var(--neg-text, #c00)" }}>
                    {error}
                  </span>
                )}
              </form>
            </section>
            {turns.map((t, i) => (
              <section className="card pad-l col" style={{ gap: 8 }} key={i} aria-label="답변">
                <span className="fw6">{t.q}</span>
                <span style={{ whiteSpace: "pre-wrap" }}>{t.a}</span>
              </section>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
