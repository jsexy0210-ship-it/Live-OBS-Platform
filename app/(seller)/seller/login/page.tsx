"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { safeNext } from "../../../../components/seller/PartnersAuth";
import { api } from "../../../../components/seller/api";

// AU-002 파트너스 관리자 로그인(정본: docs/IA.md AU-002, 대표님 결정 2026-10-03).
// 카드 안 맨 위 ONQ 로고 → 제목·부제 → 탭(대표자·직원, 기본 대표자) → 입력.
// 대표자 탭: 회원가입·아이디 찾기·비밀번호 찾기 링크 / 직원 탭: 아이디 찾기·비밀번호 찾기 링크(회원가입 없음).
// 로그인 요청에 고른 탭(accountType: owner|staff)을 함께 보낸다. 서버가 wrong_account_type을 주면 맞는 탭으로 안내하고,
// 아직 이 값을 모르는 서버는 그냥 무시하므로 지금처럼 로그인된다(하위 호환).
// 실패 문구는 서버가 주는 message를 그대로 쓴다(정본: lib/server/auth/messages.ts). 심사 중만 안내 색으로 보여 준다.
type AccountType = "owner" | "staff";
type Notice = { kind: "neg" | "info"; text: string; switchTo?: AccountType };

const TABS: { key: AccountType; label: string }[] = [
  { key: "owner", label: "대표자" },
  { key: "staff", label: "직원" },
];

export default function SellerLoginPage() {
  const router = useRouter();
  const [tab, setTab] = useState<AccountType>("owner");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [shopSlug, setShopSlug] = useState("");
  const [needShop, setNeedShop] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // 직원 탭에서 계정 찾기로 갔다가 돌아오면(?type=staff) 직원 탭으로 연다
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("type") === "staff") setTab("staff");
  }, []);

  const ready = email.trim() !== "" && password !== "" && (!needShop || shopSlug.trim() !== "");
  // 찾기 화면은 대표자·직원 공통이고 계정 종류만 넘긴다
  const q = tab === "staff" ? "?type=staff" : "";

  const choose = (t: AccountType, focusTab = false) => {
    setTab(t);
    setNotice(null);
    setFieldError(null);
    // 쇼핑몰 고르기는 그 탭에서 받은 응답 때문이라 탭을 바꾸면 처음부터
    setNeedShop(false);
    setShopSlug("");
    if (focusTab) tabRefs.current[TABS.findIndex((x) => x.key === t)]?.focus();
  };

  // 탭 키보드: 왼쪽·오른쪽 화살표로 옮기고 바로 고른다(WAI-ARIA 탭)
  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    choose(next.key, true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFieldError(null);
    setNotice(null);
    const r = await api("/api/seller/auth/login", {
      method: "POST",
      body: { email: email.trim(), password, accountType: tab, ...(needShop ? { shopSlug: shopSlug.trim() } : {}) },
    });
    if (r.ok) {
      // 직원은 본인확인을 연결하지 않았으면 로그인할 때마다 연결 안내(AU-012)로 먼저 보낸다. 건너뛸 수 있고, 상태를 못 읽으면 그냥 들어간다.
      // 본인확인을 실제로 할 수 없는 서버(대행사 미연결·테스트 모드 아님)에서는 띄우지 않는다: 서버가 available: true를 줄 때만(대행사 연결 시 켜짐)
      if (tab === "staff") {
        const s = await api<{ phoneRegistered: boolean; linked: boolean; available?: boolean }>("/api/seller/me/identity");
        if (s.ok && !s.data.linked && s.data.available === true) {
          router.replace(`/seller/identity-link?next=${encodeURIComponent(safeNext())}`);
          return;
        }
      }
      router.replace(safeNext());
      return;
    }
    setBusy(false);
    const text = r.message ?? (r.status === 0 ? "연결이 끊겼어요. 인터넷 연결을 확인해 주세요" : "로그인하지 못했어요. 잠시 뒤 다시 시도해 주세요");
    if (r.error === "wrong_account_type") {
      // 고른 탭과 계정 종류가 다르다: 맞는 탭으로 안내하고 전환 버튼을 준다
      const other: AccountType = tab === "owner" ? "staff" : "owner";
      setNotice({
        kind: "info",
        text: other === "staff" ? "직원 계정이에요. 직원 탭에서 로그인해 주세요" : "대표자 계정이에요. 대표자 탭에서 로그인해 주세요",
        switchTo: other,
      });
    } else if (r.error === "invalid_credentials") setFieldError(text);
    else if (r.error === "shop_required") {
      setNeedShop(true);
      setNotice({ kind: "info", text });
    } else setNotice({ kind: r.error === "seller_pending" ? "info" : "neg", text });
  };

  return (
    <div className="login-page">
      <form className="card col login-card" onSubmit={submit} noValidate>
        <span className="logo login-logo" aria-label="ONQ">
          <span className="logo-sym" />
          <span className="logo-word" />
        </span>
        <div className="col login-head">
          <h1 className="t-t3">파트너스 관리자</h1>
          <span className="t-l2 c-alt">쇼핑몰 운영과 방송 주문대기를 한곳에서 관리하세요.</span>
        </div>
        <div className="tabs login-tabs" role="tablist" aria-label="계정 종류">
          {TABS.map((t, i) => (
            <button
              key={t.key}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`login-tab-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls="login-panel"
              tabIndex={tab === t.key ? 0 : -1}
              className={`tab${tab === t.key ? " on" : ""}`}
              disabled={busy}
              onClick={() => choose(t.key)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="col" id="login-panel" role="tabpanel" aria-labelledby={`login-tab-${tab}`} style={{ gap: 18 }}>
          {notice && (
            <div className={`msg msg-${notice.kind}`} role="alert" style={{ display: "block" }}>
              <span>{notice.text}</span>
              {notice.switchTo && (
                <span className="row" style={{ marginTop: 8 }}>
                  <button className="btn btn-sm" type="button" onClick={() => choose(notice.switchTo!, true)}>
                    {notice.switchTo === "staff" ? "직원 탭으로" : "대표자 탭으로"}
                  </button>
                </span>
              )}
            </div>
          )}
          <div className="fld">
            <label htmlFor="email">이메일</label>
            {/* 아이디는 이메일이지만 테스트 서버 시험 계정(예: test)도 있어 브라우저 이메일 형식 검사를 쓰지 않는다 */}
            <input id="email" className="inp" type="text" inputMode="email" autoCapitalize="none" spellCheck={false} autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
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
          <nav className="row wrap t-l2 c-alt login-links" aria-label="계정 도움">
            {tab === "owner" && (
              <>
                <Link href="/seller/signup">회원가입</Link>
                <span aria-hidden>·</span>
              </>
            )}
            <Link href={`/seller/find-id${q}`}>아이디 찾기</Link>
            <span aria-hidden>·</span>
            <Link href={`/seller/password-reset${q}`}>비밀번호 찾기</Link>
          </nav>
        </div>
      </form>
    </div>
  );
}
