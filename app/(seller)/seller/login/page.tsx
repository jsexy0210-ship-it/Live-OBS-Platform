"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "../../../../components/seller/api";

// AU-002 판매자 로그인
type Notice = { kind: "neg" | "info"; title: string; body?: string };

const NOTICES: Record<string, Notice> = {
  seller_pending: { kind: "info", title: "아직 가입 심사 중이에요.", body: "결과를 메일로 알려 드려요. 보통 2영업일 안에 끝나요." },
  seller_suspended: { kind: "neg", title: "이용이 정지된 계정이에요.", body: "자세한 내용은 플랫폼 고객센터에 문의해 주세요." },
  seller_closed: { kind: "neg", title: "이용이 끝난 쇼핑몰이에요.", body: "다시 쓰려면 플랫폼 고객센터에 문의해 주세요." },
  account_disabled: { kind: "neg", title: "사용이 멈춘 계정이에요.", body: "대표자에게 계정을 다시 켜 달라고 요청해 주세요." },
};

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
    if (r.error === "invalid_credentials") setFieldError("이메일 또는 비밀번호가 맞지 않아요");
    else if (r.error === "shop_required") setNeedShop(true);
    else if (NOTICES[r.error]) setNotice(NOTICES[r.error]);
    else setNotice({ kind: "neg", title: "로그인하지 못했어요.", body: r.status === 0 ? "인터넷 연결을 확인해 주세요." : "잠시 뒤 다시 시도해 주세요." });
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
          <span className="t-l2 c-alt">쇼핑몰 운영과 방송 주문대기를 한곳에서.</span>
        </div>
        {notice && (
          <div className={`msg msg-${notice.kind}`} role="alert">
            <span>
              <b>{notice.title}</b> {notice.body}
            </span>
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
