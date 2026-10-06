"use client";

import Link from "next/link";
import { useState } from "react";

// SH-010 구매자 로그인(보드 SH-010 v298). API: POST /api/shop/{slug}/auth/login { loginId, password, remember? } → 실패면 { message }(해요체 화면 문구).
// 「로그인 유지」(기본 꺼짐)를 켜면 remember: true를 보내 30일 동안 유지하고, 끄면 브라우저를 닫을 때 끝나는 세션으로 24시간까지 쓴다(서버 정책).
// 「비회원으로 주문하기」는 없다(회원만 주문, PRODUCT_SCOPE). 「비밀번호를 잊었어요」는 SH-012(/password-reset)로 간다.
// 로그인하면 next(같은 쇼핑몰 안 경로만)나 쇼핑몰 홈으로 간다.
export default function LoginForm({ slug, shopName, next }: { slug: string; shopName: string; next: string | null }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!loginId.trim() || !password) {
      setError("이메일과 비밀번호를 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/shop/${encodeURIComponent(slug)}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loginId: loginId.trim(), password, remember }),
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
      <p className="t-l2 c-alt">{shopName} 회원으로 들어가요</p>
      <div className="fld">
        <label htmlFor="login-id">이메일</label>
        <input id="login-id" className="inp" type="email" autoComplete="username" maxLength={254} value={loginId} onChange={(e) => setLoginId(e.target.value)} />
      </div>
      <div className="fld">
        <label htmlFor="login-pw">비밀번호</label>
        <input id="login-pw" className="inp" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="shop-login-opts">
        <label className="row shop-login-keep">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          <span>로그인 유지</span>
        </label>
        <Link href={`${base}/password-reset`}>비밀번호를 잊었어요</Link>
      </div>
      {error && (
        <p className="msg msg-neg" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className={`btn btn-lg btn-block${busy ? " is-loading" : ""}`} aria-busy={busy}>
        {busy ? "확인하고 있어요…" : "로그인"}
      </button>
      <p className="t-l2 c-alt shop-login-foot">
        아직 회원이 아니에요? <Link href={`${base}/signup`}>회원가입</Link>
      </p>
    </form>
  );
}
