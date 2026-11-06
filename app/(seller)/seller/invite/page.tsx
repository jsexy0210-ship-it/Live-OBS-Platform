"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AuthFrame } from "../../../../components/seller/PartnersAuth";
import { api } from "../../../../components/seller/api";
import styles from "./page.module.css";

// AU-013 FINAL(2026-10-26). 토큰은 fragment에서 메모리로만 읽고 API 본문으로 보낸다.
// 사전 조회 API가 없으므로 대표자 정보·링크 유효성은 추측하지 않는다.
export default function SellerInvitePage() {
  const token = useRef("");
  const sending = useRef(false);
  const generation = useRef(0);
  const [state, setState] = useState<"loading" | "form" | "invalid" | "done">("loading");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loginHref, setLoginHref] = useState("/seller/login");

  useEffect(() => {
    const readInvite = () => {
      generation.current++;
      token.current = window.location.hash.slice(1);
      sending.current = false;
      setBusy(false);
      setPassword("");
      setConfirmation("");
      setPasswordError(null);
      setConfirmationError(null);
      setNotice(null);
      setLoginHref("/seller/login");
      setState(token.current.length >= 20 && token.current.length <= 200 ? "form" : "invalid");
    };
    readInvite();
    window.addEventListener("hashchange", readInvite);
    return () => {
      window.removeEventListener("hashchange", readInvite);
      generation.current++;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (sending.current || state !== "form") return;
    const error = password.length < 8 ? "8자 이상 써 주십시오" : password.length > 200 ? "200자 이하로 써 주십시오" : null;
    const mismatch = !error && password !== confirmation ? "위에 적은 비밀번호와 다릅니다" : null;
    setPasswordError(error);
    setConfirmationError(mismatch);
    if (error || mismatch) {
      document.getElementById(error ? "invite-password" : "invite-confirmation")?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setNotice(null);
    const requestGeneration = generation.current;
    const requestToken = token.current;
    const result = await api<{ ok: true; shopSlug: string }>("/api/seller/invite/accept", {
      method: "POST", body: { token: requestToken, newPassword: password }, authRedirect: false,
    });
    // 다른 초대·화면으로 이동한 뒤 도착한 응답은 새 입력과 처리 상태를 바꾸지 않는다.
    if (requestGeneration !== generation.current || window.location.hash.slice(1) !== requestToken) return;
    sending.current = false;
    setBusy(false);
    if (result.ok && typeof result.data.shopSlug === "string" && result.data.shopSlug) {
      setLoginHref(`/seller/login?shopSlug=${encodeURIComponent(result.data.shopSlug)}`);
      token.current = "";
      setPassword("");
      setConfirmation("");
      window.history.replaceState(null, "", window.location.pathname);
      setState("done");
      return;
    }
    if (!result.ok && result.error === "invalid_invite") {
      token.current = "";
      setPassword("");
      setConfirmation("");
      setState("invalid");
      return;
    }
    if (!result.ok && result.error === "weak_password") {
      setPasswordError("8자 이상 200자 이하로 써 주십시오");
      document.getElementById("invite-password")?.focus();
      return;
    }
    // 응답 유실 때 입력과 토큰을 유지한다. 같은 비밀번호 재전송은 서버가 10분간 허용한다.
    setNotice("결과를 확인하지 못했습니다. 입력한 비밀번호를 그대로 두고 다시 눌러 주십시오");
  };

  return (
    <div className={styles.page}>
      <AuthFrame>
        <h1 className={styles.title}>비밀번호를 정합니다</h1>
        <p className={styles.subtitle}>대표자 초대</p>
        {state === "loading" && <p role="status">초대 링크를 읽고 있습니다</p>}
        {state === "invalid" && <>
          <div className="msg msg-neg" role="alert" style={{ display: "block" }}>
            <b>이 초대 링크는 쓸 수 없습니다.</b> 만료됐거나 이미 썼거나 잘못된 링크입니다 · 마스터 관리자에게 초대 링크 재발급을 요청해 주십시오
          </div>
          <Link className="btn btn-sm btn-out" href="/seller/login">로그인으로</Link>
        </>}
        {state === "done" && <div role="status" className={styles.done}>
          <span>비밀번호를 정했습니다 · 로그인 화면으로 갑니다</span>
          <Link className="btn btn-lg btn-block" href={loginHref}>로그인</Link>
        </div>}
        {state === "form" && <form onSubmit={submit} noValidate>
          {notice && <div className="msg msg-neg" role="alert" style={{ display: "block" }}>{notice}</div>}
          <label className={styles.label} htmlFor="invite-password">새 비밀번호</label>
          <input id="invite-password" className={`inp${passwordError ? " is-error" : ""}`} type="password" autoComplete="new-password" maxLength={200}
            value={password} disabled={busy} onChange={(e) => { setPassword(e.target.value); setPasswordError(null); }}
            aria-invalid={!!passwordError} aria-describedby={passwordError ? "invite-password-error" : "invite-password-rule"} />
          {passwordError && <span id="invite-password-error" className="err" role="alert">{passwordError}</span>}
          <span id="invite-password-rule" className={styles.hint}>8자 이상 200자 이하</span>
          <label className={styles.label} htmlFor="invite-confirmation">새 비밀번호 확인</label>
          <input id="invite-confirmation" className={`inp${confirmationError ? " is-error" : ""}`} type="password" autoComplete="new-password" maxLength={200}
            value={confirmation} disabled={busy} onChange={(e) => { setConfirmation(e.target.value); setConfirmationError(null); }}
            aria-invalid={!!confirmationError} aria-describedby={confirmationError ? "invite-confirmation-error" : "invite-notice"} />
          {confirmationError && <span id="invite-confirmation-error" className="err" role="alert">{confirmationError}</span>}
          <span id="invite-notice" className={styles.hint}>이 링크는 72시간 안에 한 번만 쓸 수 있습니다 · 비밀번호를 정하면 로그인 화면으로 갑니다(자동 로그인 없음)</span>
          <button className="btn btn-lg btn-block" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? "비밀번호를 정하고 있습니다" : "비밀번호 정하기"}
          </button>
        </form>}
      </AuthFrame>
    </div>
  );
}
