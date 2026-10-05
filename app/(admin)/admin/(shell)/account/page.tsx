"use client";

import { useEffect, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { Toast } from "../../../../../components/seller/States";
import { adminApi, failMessage } from "../../_components/api";
import { AdminTopbar, useAdmin } from "../../_components/AdminShell";
import { MIN_PASSWORD, ROLE_LABEL } from "../../_components/accounts";

// MA-090 내 계정(POST /api/admin/me/password, 모든 마스터 역할, 본인만). 비밀번호만 바꾼다.
// 「다른 곳에서 로그아웃」은 서버가 true·false를 반드시 받아서 체크박스로 고르게 한다(기본: 로그아웃). 현재 비밀번호를 여러 번 틀리면 429라서 남은 시간을 세어 보여 준다.
type Done = { signedOutOthers: boolean; signedOutSessions: number };

export default function AdminAccountPage() {
  const { me } = useAdmin();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const mismatch = again !== "" && next !== again;
  const ready = current !== "" && next.length >= MIN_PASSWORD && next === again && !busy && wait <= 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    const r = await adminApi<Done>("/api/admin/me/password", { method: "POST", json: { currentPassword: current, newPassword: next, signOutOthers } });
    setBusy(false);
    if (r.ok) {
      setCurrent("");
      setNext("");
      setAgain("");
      setToast(r.data.signedOutOthers ? `비밀번호를 바꿨습니다. 다른 기기 ${r.data.signedOutSessions}대는 로그아웃했습니다.` : "비밀번호를 바꿨습니다.");
      return;
    }
    if (r.status === 429 && r.retryAfterSeconds) setWait(r.retryAfterSeconds);
    setError(failMessage(r));
  };

  return (
    <>
      <AdminTopbar crumb="내 계정" />
      <main className="main">
        <PageHead title="내 계정" />
        <div className="col" style={{ gap: 20, maxWidth: 520 }}>
          <div className="card pad col" style={{ gap: 4 }}>
            <b>{me.name}</b>
            <span className="c-alt">{me.email}</span>
            <span className="c-alt">{ROLE_LABEL[me.role]}</span>
          </div>
          <form className="card pad col" style={{ gap: 16 }} onSubmit={(e) => void submit(e)} noValidate>
            <b>비밀번호 변경</b>
            <div className="field">
              <label htmlFor="cur">현재 비밀번호</label>
              <input id="cur" className="inp" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="new">새 비밀번호</label>
              <input id="new" className="inp" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} aria-describedby="new-help" />
              <span id="new-help" className="c-alt t-l2">
                {MIN_PASSWORD}자 이상 입력해 주십시오.
              </span>
            </div>
            <div className="field">
              <label htmlFor="again">새 비밀번호 확인</label>
              <input id="again" className={`inp${mismatch ? " is-error" : ""}`} type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} aria-invalid={mismatch} />
              {mismatch && (
                <span className="err" role="alert">
                  새 비밀번호가 서로 다릅니다.
                </span>
              )}
            </div>
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={signOutOthers} onChange={(e) => setSignOutOthers(e.target.checked)} />
              <span>다른 곳에서 로그인한 기기는 로그아웃</span>
            </label>
            {error && (
              <span className="err" role="alert">
                {error}
                {wait > 0 && ` (${Math.ceil(wait / 60)}분 뒤 가능)`}
              </span>
            )}
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className={`btn${busy ? " is-loading" : ""}`} type="submit" disabled={!ready}>
                {busy ? "변경 중" : "비밀번호 변경"}
              </button>
            </div>
          </form>
        </div>
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
