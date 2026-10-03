"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import IdentityCheck from "../../../../components/seller/IdentityCheck";
import { AuthFrame, IdentityUnavailable } from "../../../../components/seller/PartnersAuth";
import { api, failMessage } from "../../../../components/seller/api";

// AU-003 비밀번호 찾기 → AU-004 새 비밀번호. 쇼핑몰 대표자 본인만 할 수 있다(대표자 휴대폰 본인확인, 메일 링크 없음).
// API: POST /api/seller/password-reset/start(·/resend·/confirm) → /verify(재설정 권한) → /complete(새 비밀번호).
// 서버는 계정이 있는지·대표자인지 따로 알려 주지 않는다(reset_not_allowed 하나). 직원 계정은 대표자에게 재설정을 요청하도록 안내한다.
// 본인확인 대행사 연결 전에는 API가 503을 주고, 이 화면은 「본인확인 서비스 준비 중이에요」 상태로 바꾼다.
const BASE = "/api/seller/password-reset";
const MIN_PASSWORD_LENGTH = 8; // 서버(lib/server/auth/passwordReset.ts)와 같은 값

type Step = "find" | "password" | "done";

export default function PasswordResetPage() {
  const [step, setStep] = useState<Step>("find");
  const [unavailable, setUnavailable] = useState(false);
  const [email, setEmail] = useState("");
  const [shopSlug, setShopSlug] = useState("");
  const [idvKey, setIdvKey] = useState(0);
  const [notice, setNotice] = useState<{ title?: string; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 인증번호를 보낸 뒤에는 그 요청에 쓴 이메일·쇼핑몰 주소를 바꿀 수 없다(「정보 다시 입력」으로 풀린다)
  const [codeSent, setCodeSent] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pw2Error, setPw2Error] = useState<string | null>(null);
  const [focusTo, setFocusTo] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (!focusTo) return;
    document.getElementById(focusTo.id)?.focus();
    setFocusTo(null);
  }, [focusTo]);
  const focus = (id: string) => setFocusTo({ id });

  const toUnavailable = () => {
    setUnavailable(true);
    focus("pa-state-title");
  };

  // 처음부터 다시(이메일·쇼핑몰 주소는 그대로, 본인확인 칸은 비운다)
  const restart = (n: { title?: string; text: string }) => {
    setStep("find");
    setPending(null);
    setIdvKey((k) => k + 1);
    setNotice(n);
    focus("pa-notice");
  };

  // 본인확인을 마치면 재설정 권한을 받는다(대표자 CI와 맞아야 한다)
  const verify = async (verificationId: string) => {
    setBusy(true);
    setNotice(null);
    const r = await api(`${BASE}/verify`, { method: "POST", body: { verificationId } });
    setBusy(false);
    if (r.ok) {
      setPending(null);
      setStep("password");
      focus("pw-new");
      return;
    }
    if (r.status === 503) return toUnavailable();
    // 본인확인 결과를 아직 받는 중: 같은 요청으로 다시 누르게 한다
    if (r.error === "pending") {
      setPending(verificationId);
      setNotice({ text: "본인확인 결과를 확인하고 있어요. 잠시 뒤 다시 눌러 주세요" });
      return focus("pa-notice");
    }
    if (r.error === "reset_not_allowed") {
      return restart({ title: "비밀번호를 바꿀 수 없어요", text: "이메일 · 쇼핑몰 주소와 대표자 본인인지 확인해 주세요. 직원 계정은 대표자에게 재설정을 요청해 주세요." });
    }
    restart({ text: failMessage(r, "확인하지 못했어요. 처음부터 다시 해 주세요") });
  };

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
    const r = await api(`${BASE}/complete`, { method: "POST", body: { newPassword: pw } });
    setBusy(false);
    if (r.ok) {
      setStep("done");
      return focus("pa-done-title");
    }
    if (r.error === "weak_password") {
      setPwError(`${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`);
      return focus("pw-new");
    }
    if (r.error === "invalid_grant") return restart({ text: "시간이 지나 처음부터 다시 해야 해요. 본인확인을 다시 해 주세요" });
    setNotice({ text: failMessage(r, "바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요") });
    focus("pa-notice");
  };

  const findReady = email.trim() !== "" && shopSlug.trim() !== "";

  return (
    <AuthFrame>
      {step === "done" ? (
        <div className="col" style={{ gap: 14, alignItems: "center", textAlign: "center" }}>
          <h1 className="t-t3" id="pa-done-title" tabIndex={-1}>
            비밀번호를 바꿨어요
          </h1>
          <span className="t-l2 c-alt">다른 기기의 로그인은 모두 풀렸어요. 새 비밀번호로 로그인해 주세요.</span>
          <Link className="btn btn-lg btn-block" href="/seller/login">
            로그인하기
          </Link>
        </div>
      ) : (
        <>
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">{step === "find" ? "비밀번호를 찾아요" : "새 비밀번호를 정해요"}</h1>
            <span className="t-l2 c-alt">
              {step === "find"
                ? "가입한 이메일과 쇼핑몰 주소를 적고 휴대폰 본인확인을 하면 바로 새 비밀번호를 정할 수 있어요."
                : `${email.trim()} · 휴대폰 본인확인 완료`}
            </span>
          </div>
          {unavailable ? (
            <IdentityUnavailable action="비밀번호를 찾을" />
          ) : (
            <>
              {notice && (
                <div id="pa-notice" tabIndex={-1} className="msg msg-neg" role="alert" style={{ display: "block" }}>
                  {notice.title ? (
                    <>
                      <b style={{ display: "block", marginBottom: 4 }}>{notice.title}</b>
                      {notice.text}
                    </>
                  ) : (
                    notice.text
                  )}
                  {pending && (
                    <span className="row" style={{ marginTop: 8 }}>
                      <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void verify(pending)}>
                        다시 확인하기
                      </button>
                    </span>
                  )}
                </div>
              )}
              {step === "find" ? (
                <>
                  <div className="msg msg-info" style={{ display: "block" }}>
                    <b style={{ display: "block", marginBottom: 4 }}>대표자 본인만 찾을 수 있어요.</b>
                    직원 계정은 대표자에게 재설정을 요청해 주세요.
                  </div>
                  <div className="fld">
                    <label htmlFor="pr-email">이메일</label>
                    <input id="pr-email" className="inp" type="text" inputMode="email" autoCapitalize="none" spellCheck={false} autoComplete="username" value={email} disabled={busy || codeSent} onChange={(e) => setEmail(e.target.value)} />
                  </div>
                  <div className="fld">
                    <label htmlFor="pr-shop">쇼핑몰 주소</label>
                    <input
                      id="pr-shop"
                      className="inp"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="예: byulbit"
                      value={shopSlug}
                      disabled={busy || codeSent}
                      onChange={(e) => setShopSlug(e.target.value.toLowerCase())}
                    />
                    <span className="help">가입할 때 정한 쇼핑몰 주소예요</span>
                  </div>
                  <IdentityCheck
                    key={idvKey}
                    label="휴대폰 본인확인"
                    base={BASE}
                    blocked={!findReady || busy}
                    start={(person) => api<{ verificationId: string }>(`${BASE}/start`, { method: "POST", body: { email: email.trim(), shopSlug: shopSlug.trim(), person } })}
                    onUnavailable={toUnavailable}
                    onSentChange={setCodeSent}
                    onVerified={(id) => void verify(id)}
                  />
                </>
              ) : (
                <form className="col" style={{ gap: 14 }} onSubmit={complete} noValidate>
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
              )}
            </>
          )}
          {!unavailable && (
            <div className="row t-l2 c-alt" style={{ justifyContent: "center" }}>
              <Link href="/seller/login">로그인으로 돌아가기</Link>
            </div>
          )}
        </>
      )}
    </AuthFrame>
  );
}
