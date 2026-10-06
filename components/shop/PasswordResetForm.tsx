"use client";

import Link from "next/link";
import { useState } from "react";
import { call } from "./reviewShared";

// SH-012 비밀번호 찾기(보드 FINAL v298). API(#782): POST /api/shop/{slug}/auth/password-reset/request { loginId } → 항상 200(가입 여부는 알려 주지 않는다),
// POST .../password-reset/confirm { token, password } → 200 | 400 weak_password·token_invalid | 410 token_expired(30분 지남).
// 「가입하지 않은 이메일이에요」 상태는 서버가 가입 여부를 숨기므로 만들지 않는다(보드 정정 대기). 성공해도 자동 로그인은 하지 않고 로그인으로 보낸다.
type Mode = "request" | "sent" | "set" | "expired" | "done";

const maskEmail = (v: string) => {
  const [id, host] = v.split("@");
  return host ? `${id.slice(0, 3)}${"*".repeat(4)}@${host}` : v;
};

export default function PasswordResetForm({ slug, token }: { slug: string; token: string | null }) {
  const base = `/shop/${encodeURIComponent(slug)}`;
  const api = `/api/shop/${encodeURIComponent(slug)}/auth/password-reset`;
  const [mode, setMode] = useState<Mode>(token ? "set" : "request");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function request(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!email.trim()) {
      setError("이메일을 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await call(`${api}/request`, { method: "POST", body: { loginId: email.trim() } });
    setBusy(false);
    if (r.ok) {
      setMode("sent");
      return;
    }
    setError(
      r.status === 400
        ? "이메일을 확인해 주세요."
        : r.status === 429
          ? "너무 자주 요청했어요. 잠시 뒤 다시 해 주세요."
          : r.status === 503
            ? "메일을 보내지 못했어요. 잠시 뒤 다시 해 주세요."
            : "연결이 끊겼어요. 잠시 뒤 다시 해 주세요.",
    );
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (pw.length < 8) {
      setError("비밀번호는 8자 이상으로 입력해 주세요.");
      return;
    }
    if (pw !== pw2) {
      setError("비밀번호가 서로 달라요.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await call(`${api}/confirm`, { method: "POST", body: { token, password: pw } });
    setBusy(false);
    if (r.ok) {
      setMode("done");
      return;
    }
    if (r.status === 410) {
      setMode("expired");
      return;
    }
    setError(
      r.status === 400 && r.error === "weak_password"
        ? "비밀번호는 8자 이상으로 입력해 주세요."
        : r.status === 400
          ? "이 링크는 쓸 수 없어요. 재설정 메일을 다시 받아 주세요."
          : "연결이 끊겼어요. 잠시 뒤 다시 해 주세요.",
    );
  }

  if (mode === "sent")
    return (
      <section className="card shop-card shop-login col" role="status">
        <h1 className="t-h1">메일을 보냈어요.</h1>
        <p className="t-l2 c-alt">{maskEmail(email.trim())} · 링크는 30분 동안 쓸 수 있어요 · 메일이 없으면 스팸함을 확인해 주세요</p>
        <Link className="btn btn-lg btn-block" href={`${base}/login`}>
          로그인으로 돌아가기
        </Link>
      </section>
    );

  if (mode === "done")
    return (
      <section className="card shop-card shop-login col" role="status">
        <h1 className="t-h1">비밀번호를 바꿨어요</h1>
        <p className="t-l2 c-alt">새 비밀번호로 로그인해 주세요.</p>
        <Link className="btn btn-lg btn-block" href={`${base}/login`}>
          로그인하기
        </Link>
      </section>
    );

  if (mode === "expired")
    return (
      <section className="card shop-card shop-login col" role="alert">
        <h1 className="t-h1">비밀번호 찾기</h1>
        <p className="msg msg-neg">링크가 만료됐어요 (30분 지남) · 다시 요청해 주세요</p>
        <button type="button" className="btn btn-lg btn-block" onClick={() => { setMode("request"); setError(null); setPw(""); setPw2(""); }}>
          다시 보내기
        </button>
      </section>
    );

  if (mode === "set")
    return (
      <form className="card shop-card shop-login col" onSubmit={confirm} noValidate>
        <h1 className="t-h1">새 비밀번호 설정</h1>
        <div className="fld">
          <label htmlFor="pr-pw">새 비밀번호</label>
          <input id="pr-pw" className="inp" type="password" autoComplete="new-password" maxLength={200} value={pw} onChange={(e) => setPw(e.target.value)} />
          <p className="t-l2 c-alt">8자 이상</p>
        </div>
        <div className="fld">
          <label htmlFor="pr-pw2">새 비밀번호 확인</label>
          <input id="pr-pw2" className="inp" type="password" autoComplete="new-password" maxLength={200} value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </div>
        {error && (
          <p className="msg msg-neg" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className={`btn btn-lg btn-block${busy ? " is-loading" : ""}`} aria-busy={busy}>
          {busy ? "바꾸고 있어요…" : "비밀번호 바꾸기"}
        </button>
      </form>
    );

  return (
    <form className="card shop-card shop-login col" onSubmit={request} noValidate>
      <h1 className="t-h1">비밀번호 찾기</h1>
      <p className="t-l2 c-alt">가입한 이메일로 재설정 링크를 보내 드려요 · 링크는 30분 동안 쓸 수 있어요</p>
      <div className="fld">
        <label htmlFor="pr-email">이메일</label>
        <input id="pr-email" className="inp" type="email" autoComplete="username" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      {error && (
        <p className="msg msg-neg" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className={`btn btn-lg btn-block${busy ? " is-loading" : ""}`} aria-busy={busy}>
        {busy ? "보내고 있어요…" : "재설정 메일 보내기"}
      </button>
      <p className="t-l2 c-alt shop-login-foot">
        <Link href={`${base}/login`}>로그인으로 돌아가기</Link>
      </p>
    </form>
  );
}
