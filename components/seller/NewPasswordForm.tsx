"use client";

import { useEffect, useState } from "react";
import { api, failMessage } from "./api";

// AU-004 새 비밀번호 입력. 비밀번호 찾기(AU-003)와 아이디 찾기에서 고른 계정(AU-011) 모두 재설정 권한(쿠키 lo_pwreset)을 받은 뒤 이 칸으로 저장한다.
// API: POST /api/seller/password-reset/complete { newPassword }. 권한이 지났으면(invalid_grant) onExpired로 처음부터 다시 하게 한다.
const MIN_PASSWORD_LENGTH = 8; // 서버(lib/server/auth/passwordReset.ts)와 같은 값

type Props = { onDone: () => void; onExpired: () => void };

export default function NewPasswordForm({ onDone, onExpired }: Props) {
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pw2Error, setPw2Error] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusTo, setFocusTo] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (!focusTo) return;
    document.getElementById(focusTo.id)?.focus();
    setFocusTo(null);
  }, [focusTo]);
  const focus = (id: string) => setFocusTo({ id });
  useEffect(() => focus("pw-new"), []);

  const complete = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const a = pw.length < MIN_PASSWORD_LENGTH ? `${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요` : null;
    const b = !a && pw !== pw2 ? "위에 적은 비밀번호와 달라요" : null;
    setPwError(a);
    setPw2Error(b);
    if (a || b) return focus(a ? "pw-new" : "pw-again");
    setBusy(true);
    setNotice(null);
    const r = await api("/api/seller/password-reset/complete", { method: "POST", body: { newPassword: pw } });
    setBusy(false);
    if (r.ok) return onDone();
    if (r.error === "weak_password") {
      setPwError(`${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`);
      return focus("pw-new");
    }
    if (r.error === "invalid_grant") return onExpired();
    setNotice(failMessage(r, "바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요"));
    focus("pw-notice");
  };

  return (
    <form className="col" style={{ gap: 14 }} onSubmit={complete} noValidate>
      {notice && (
        <div id="pw-notice" tabIndex={-1} className="msg msg-neg" role="alert">
          <span>{notice}</span>
        </div>
      )}
      <div className="fld">
        <label htmlFor="pw-new">새 비밀번호</label>
        <input
          id="pw-new"
          disabled={busy}
          className={`inp${pwError ? " is-error" : ""}`}
          type="password"
          autoComplete="new-password"
          maxLength={200}
          value={pw}
          onChange={(e) => {
            setPw(e.target.value);
            setPwError(null);
          }}
          aria-invalid={!!pwError}
          aria-describedby={pwError ? "pw-new-err" : "pw-rule"}
        />
        {pwError && (
          <span id="pw-new-err" className="err" role="alert">
            {pwError}
          </span>
        )}
        <span id="pw-rule" className="row t-c1" style={{ gap: 6, color: pw.length >= MIN_PASSWORD_LENGTH ? "var(--pos-text)" : "var(--wds-label-alternative)" }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12l5 5L20 7" />
          </svg>
          {MIN_PASSWORD_LENGTH}자 이상
        </span>
      </div>
      <div className="fld">
        <label htmlFor="pw-again">새 비밀번호 확인</label>
        <input
          id="pw-again"
          disabled={busy}
          className={`inp${pw2Error ? " is-error" : ""}`}
          type="password"
          autoComplete="new-password"
          maxLength={200}
          value={pw2}
          onChange={(e) => {
            setPw2(e.target.value);
            setPw2Error(null);
          }}
          aria-invalid={!!pw2Error}
          aria-describedby={pw2Error ? "pw-again-err" : undefined}
        />
        {pw2Error && (
          <span id="pw-again-err" className="err" role="alert">
            {pw2Error}
          </span>
        )}
      </div>
      <span className="t-c1 c-alt">바꾸면 다른 기기의 로그인은 모두 풀려요</span>
      <button className={`btn btn-lg btn-block${busy ? " is-loading" : ""}`} type="submit" disabled={busy || pw === "" || pw2 === ""}>
        {busy ? "바꾸고 있어요" : "비밀번호 바꾸기"}
      </button>
    </form>
  );
}
