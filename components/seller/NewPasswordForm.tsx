"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api, failMessage } from "./api";
import { stepOutcome } from "./stepFailure";

// AU-004 새 비밀번호 입력. 비밀번호 찾기(AU-003)와 아이디 찾기에서 고른 계정(AU-011) 모두 재설정 권한(쿠키 lo_pwreset)을 받은 뒤 이 칸으로 저장한다.
// API: POST /api/seller/password-reset/complete { newPassword }. 권한이 지났으면(invalid_grant) onExpired로 처음부터 다시 하게 한다.
const MIN_PASSWORD_LENGTH = 8; // 서버(lib/server/auth/passwordReset.ts)와 같은 값

// 저장 응답을 놓치면(연결 끊김·서버 오류) 비밀번호가 바뀌었는지 알 수 없다: 그 자리에서 방금 정한 비밀번호로 로그인해 보게 안내하고(loginHref),
// 같은 칸으로 다시 저장할 수도 있게 둔다. 다시 눌러 invalid_grant가 오면 권한은 이미 쓰인 것이므로 처음부터(유료 본인확인) 보내지 않고 같은 안내만 남긴다
type Props = { onDone: () => void; onExpired: () => void; loginHref: string };

export default function NewPasswordForm({ onDone, onExpired, loginHref }: Props) {
  const uncertain = useRef(false);
  const [maybeChanged, setMaybeChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pw2Error, setPw2Error] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; maybe?: boolean } | null>(null);
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
    const a = pw.length < MIN_PASSWORD_LENGTH ? `${MIN_PASSWORD_LENGTH}자 이상으로 정해 주십시오` : null;
    const b = !a && pw !== pw2 ? "위에 입력한 비밀번호와 다릅니다" : null;
    setPwError(a);
    setPw2Error(b);
    if (a || b) return focus(a ? "pw-new" : "pw-again");
    setBusy(true);
    setNotice(null);
    const r = await api("/api/seller/password-reset/complete", { method: "POST", body: { newPassword: pw } });
    setBusy(false);
    if (r.ok) return onDone();
    if (r.error === "weak_password") {
      setPwError(`${MIN_PASSWORD_LENGTH}자 이상으로 정해 주십시오`);
      return focus("pw-new");
    }
    if (r.error === "invalid_grant") {
      if (!uncertain.current) return onExpired();
      setMaybeChanged(true);
      return focus("pw-maybe");
    }
    if (stepOutcome(r) === "retry") {
      uncertain.current = true;
      setNotice({ text: "새 비밀번호로 로그인해 보십시오. 되지 않으면 다시 변경해 주십시오", maybe: true });
    } else setNotice({ text: failMessage(r, "admin", "변경하지 못했습니다. 잠시 후 다시 시도해 주십시오") });
    focus("pw-notice");
  };

  if (maybeChanged) {
    return (
      <div className="col" style={{ gap: 12 }}>
        <div id="pw-maybe" tabIndex={-1} className="msg msg-info" role="status" style={{ display: "block" }}>
          <span>
            <b>비밀번호가 이미 변경되었을 수 있습니다.</b> 방금 정한 비밀번호로 로그인해 보십시오.
          </span>
        </div>
        <Link className="btn btn-lg btn-block" href={loginHref}>
          로그인
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
        <div id="pw-notice" tabIndex={-1} className={`msg ${notice.maybe ? "msg-info" : "msg-neg"}`} role="alert" style={{ display: "block" }}>
          {notice.maybe ? (
            <>
              <span>
                <b>비밀번호가 변경되었을 수 있습니다.</b> {notice.text}
              </span>
              <span className="row" style={{ marginTop: 8 }}>
                <Link className="btn btn-sm" href={loginHref}>
                  로그인
                </Link>
              </span>
            </>
          ) : (
            <span>{notice.text}</span>
          )}
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
      <span className="t-c1 c-alt">변경하면 다른 기기의 로그인은 모두 해제됩니다</span>
      <button className={`btn btn-lg btn-block${busy ? " is-loading" : ""}`} type="submit" disabled={busy || pw === "" || pw2 === ""}>
        {busy ? "변경 중" : "비밀번호 변경"}
      </button>
    </form>
  );
}
