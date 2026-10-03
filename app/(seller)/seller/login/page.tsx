"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../../../components/seller/api";

// AU-002 판매자 로그인
// 실패 문구는 서버가 주는 message를 그대로 쓴다(정본: lib/server/auth/messages.ts). 심사 중만 안내 색으로 보여 준다.
type Notice = { kind: "neg" | "info"; text: string };

// 로그인 뒤에는 판매자 화면 안의 주소로만 돌려보낸다(다른 사이트로 넘기지 않음)
function nextPath(): string {
  const next = new URLSearchParams(window.location.search).get("next");
  return next && /^\/seller(\/[\w\-/]*)?$/.test(next) && next !== "/seller/login" ? next : "/seller/products";
}

export default function SellerLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [shopSlug, setShopSlug] = useState("");
  const [needShop, setNeedShop] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = email.trim() !== "" && password !== "" && (!needShop || shopSlug.trim() !== "");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFieldError(null);
    setNotice(null);
    const r = await api("/api/seller/auth/login", {
      method: "POST",
      body: { email: email.trim(), password, ...(needShop ? { shopSlug: shopSlug.trim() } : {}) },
    });
    if (r.ok) {
      router.replace(nextPath());
      return;
    }
    setBusy(false);
    const text = r.message ?? (r.status === 0 ? "연결이 끊겼어요. 인터넷 연결을 확인해 주세요" : "로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요");
    if (r.error === "invalid_credentials") setFieldError(text);
    else if (r.error === "shop_required") {
      setNeedShop(true);
      setNotice({ kind: "info", text });
    } else setNotice({ kind: r.error === "seller_pending" ? "info" : "neg", text });
  };

  return (
    <div className="login-page">
      <span className="logo" style={{ fontSize: 22 }}>
        <span className="logo-sym" />
        <span className="logo-word" />
        <span className="t-l1 c-alt" style={{ marginLeft: 6 }}>
          판매자
        </span>
      </span>
      <form className="card col login-card" onSubmit={submit} noValidate>
        <div className="col" style={{ gap: 4 }}>
          <h1 className="t-t3">판매자 관리자에 로그인해요</h1>
          <span className="t-l2 c-alt">쇼핑몰 운영과 방송 주문대기를 한곳에서 할 수 있어요.</span>
        </div>
        {notice && (
          <div className={`msg msg-${notice.kind}`} role="alert">
            <span>{notice.text}</span>
          </div>
        )}
        <div className="fld">
          <label htmlFor="email">이메일</label>
          <input id="email" className="inp" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="fld">
          <label htmlFor="password">비밀번호</label>
          <input
            id="password"
            className={`inp${fieldError ? " is-error" : ""}`}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!fieldError}
            aria-describedby={fieldError ? "login-err" : undefined}
          />
          {fieldError && (
            <span id="login-err" className="err" role="alert">
              {fieldError}
            </span>
          )}
        </div>
        {needShop && (
          <div className="fld">
            <label htmlFor="shop">쇼핑몰 주소</label>
            <input id="shop" className="inp" type="text" placeholder="예: byulbit" value={shopSlug} onChange={(e) => setShopSlug(e.target.value)} />
            <span className="help">이 이메일로 쓰는 쇼핑몰이 여러 곳이에요. 로그인할 쇼핑몰 주소를 넣어 주세요</span>
          </div>
        )}
        <button className={`btn btn-lg btn-block${busy ? " is-loading" : ""}`} type="submit" disabled={!ready || busy}>
          {busy ? (
            <>
              <span className="spin" style={{ width: 18, height: 18 }} />
              로그인하고 있어요
            </>
          ) : (
            "로그인"
          )}
        </button>
      </form>
    </div>
  );
}
