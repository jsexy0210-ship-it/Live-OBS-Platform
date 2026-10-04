"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminApi, safeAdminNext } from "../_components/api";

// 마스터 관리자 로그인(이메일 + 비밀번호, POST /api/admin/auth/login). 파트너스 관리자 로그인 화면과 같은 카드 모양을 쓴다.
// 마스터·파트너스 관리자 화면은 명사형·합니다체(대표님 지시 2026-10-04)라 서버 문구(해요체, lib/server/auth/messages.ts) 대신
// 실패 코드별 문구를 여기서 쓴다. 이메일과 비밀번호 중 무엇이 틀렸는지는 구분하지 않는다.
const LOGIN_FAILURE: Record<string, string> = {
  bad_request: "이메일과 비밀번호를 입력해 주십시오.",
  invalid_credentials: "이메일 또는 비밀번호가 올바르지 않습니다.",
  account_disabled: "현재 이 계정으로 로그인할 수 없습니다. 최고관리자에게 문의해 주십시오.",
};

export default function AdminLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = email.trim() !== "" && password !== "";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const r = await adminApi("/api/admin/auth/login", { method: "POST", json: { email: email.trim(), password } });
    if (r.ok) {
      router.replace(safeAdminNext());
      return;
    }
    setBusy(false);
    setError(LOGIN_FAILURE[r.error] ?? (r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오." : "로그인하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };

  return (
    <div className="login-page">
      <form className="card col login-card" onSubmit={submit} noValidate>
        <span className="logo login-logo" aria-label="ONQ">
          <span className="logo-sym" />
          <span className="logo-word" />
        </span>
        <div className="col login-head">
          <h1 className="t-t3">마스터 관리자</h1>
          <span className="t-l2 c-alt">플랫폼 운영 계정으로 로그인해 주십시오.</span>
        </div>
        <div className="col" style={{ gap: 18 }}>
          <div className="fld">
            <label htmlFor="email">이메일</label>
            <input id="email" className="inp" type="text" inputMode="email" autoCapitalize="none" spellCheck={false} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="password">비밀번호</label>
            <input
              id="password"
              className={`inp${error ? " is-error" : ""}`}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!error}
              aria-describedby={error ? "login-err" : undefined}
            />
            {error && (
              <span id="login-err" className="err" role="alert">
                {error}
              </span>
            )}
          </div>
          <button className={`btn btn-lg btn-block${busy ? " is-loading" : ""}`} type="submit" disabled={!ready || busy}>
            {busy ? (
              <>
                <span className="spin" style={{ width: 18, height: 18 }} />
                로그인 중
              </>
            ) : (
              "로그인"
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
