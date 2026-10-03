"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, failMessage } from "./api";

// AU-004 새 비밀번호 입력. 비밀번호 찾기(AU-003)와 아이디 찾기에서 고른 계정(AU-011) 모두 재설정 권한(쿠키 lo_pwreset)을 받은 뒤 이 칸으로 저장한다.
// API: POST /api/seller/password-reset/complete { newPassword }. 권한이 지났으면(invalid_grant) onExpired로 처음부터 다시 하게 한다.
const MIN_PASSWORD_LENGTH = 8; // 서버(lib/server/auth/passwordReset.ts)와 같은 값

// 저장 응답을 놓친 뒤(연결 끊김·서버 오류) 다시 누르면 invalid_grant가 올 수 있다: 권한은 이미 쓰였고 비밀번호가 바뀌었을 수 있으므로,
// 바로 처음부터(유료 본인확인) 보내지 않고 방금 정한 비밀번호로 로그인해 보게 한다(loginHref)
type Props = { onDone: () => void; onExpired: () => void; loginHref: string };

export default function NewPasswordForm({ onDone, onExpired, loginHref }: Props) {
  const uncertain = useRef(false);
  const [maybeChanged, setMaybeChanged] = useState(false);
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
    if (r.error === "invalid_grant") {
      if (!uncertain.current) return onExpired();
      setMaybeChanged(true);
      return focus("pw-maybe");
    }
    if (r.status === 0 || r.status >= 500) uncertain.current = true;
    setNotice(failMessage(r, "바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요"));
    focus("pw-notice");
  };

  if (maybeChanged) {
    return (
      <div className="col" style={{ gap: 12 }}>
        <div id="pw-maybe" tabIndex={-1} className="msg msg-info" role="status" style={{ display: "block" }}>
          <span>
            <b>비밀번호가 이미 바뀌었을 수 있어요.</b> 방금 정한 비밀번호로 로그인해 보세요.
          </span>
        </div>
        <Link className="btn btn-lg btn-block" href={loginHref}>
          로그인하기
        </Link>
        <button className="btn btn-lg btn-block btn-out" type="button" onClick={onExpired}>
          처음부터 다시 찾기
        </button>
      </div>
    );
  }

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
