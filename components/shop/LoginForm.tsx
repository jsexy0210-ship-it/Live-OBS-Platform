"use client";

import Link from "next/link";
import { useState } from "react";

// SH-010 구매자 로그인. API: POST /api/shop/{slug}/auth/login { loginId, password } → 실패면 { message }(해요체 화면 문구).
// 로그인하면 next(같은 쇼핑몰 안 경로만)나 쇼핑몰 홈으로 간다.
export default function LoginForm({ slug, next }: { slug: string; next: string | null }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!loginId.trim() || !password) {
      setError("아이디와 비밀번호를 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/shop/${encodeURIComponent(slug)}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginId: loginId.trim(), password }),
      });
      if (res.ok) {
        window.location.replace(next ?? base); // 뒤로 가기로 로그인 화면에 돌아오지 않게 기록을 바꾼다
        return;
      }
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(body?.message ?? "로그인하지 못했어요. 잠시 뒤 다시 해 주세요.");
    } catch {
      setError("연결이 끊겼어요. 잠시 뒤 다시 해 주세요.");
    }
    setBusy(false);
  }

  return (
    <form className="card shop-card shop-login col" onSubmit={submit} noValidate>
      <h1 className="t-h1">로그인</h1>
      <div className="fld">
        <label htmlFor="login-id">아이디(이메일)</label>
        <input id="login-id" className="inp" type="email" autoComplete="username" maxLength={254} value={loginId} onChange={(e) => setLoginId(e.target.value)} />
      </div>
      <div className="fld">
        <label htmlFor="login-pw">비밀번호</label>
        <input id="login-pw" className="inp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error && (
        <p className="msg msg-neg" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className={`btn btn-lg btn-block${busy ? " is-loading" : ""}`} aria-busy={busy}>
        로그인
      </button>
      <p className="t-l2 c-alt shop-login-foot">
        아직 회원이 아니신가요? <Link href={`${base}/signup`}>회원가입</Link>
      </p>
    </form>
  );
}
