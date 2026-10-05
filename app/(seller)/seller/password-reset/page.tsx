"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ConfirmProvider } from "../../../../components/admin-ui";
import IdentityCheck from "../../../../components/seller/IdentityCheck";
import NewPasswordForm from "../../../../components/seller/NewPasswordForm";
import { AuthFrame, FindSwitch, IdentityUnavailable, useStaffType, withType } from "../../../../components/seller/PartnersAuth";
import { api, failMessage } from "../../../../components/seller/api";
import { RETRY_TEXT, stepOutcome } from "../../../../components/seller/stepFailure";

// AU-003 비밀번호 찾기 → AU-004 새 비밀번호. 쇼핑몰 대표자 본인만 할 수 있다(대표자 휴대폰 본인확인, 메일 링크 없음).
// API: POST /api/seller/password-reset/start(·/resend·/confirm) → /verify(재설정 권한) → /complete(새 비밀번호).
// 서버는 계정이 있는지·대표자인지 따로 알려 주지 않는다(reset_not_allowed 하나).
// 로그인 화면 직원 탭에서 오면 ?type=staff(정본: docs/IA.md AU-003). 화면은 대표자·직원 공통이고 요청에 accountType만 다르게 보낸다.
// 직원 본인확인이 맞지 않으면 그때만 「등록된 직원 정보와 맞지 않아요. 대표자에게 물어봐 주세요」를 보여 준다.
// 본인확인 대행사 연결 전에는 API가 503을 주고, 이 화면은 「본인확인 서비스 준비 중이에요」 상태로 바꾼다.
const BASE = "/api/seller/password-reset";

type Step = "find" | "password" | "done";

// 로그인 전 화면이라 셸이 없으므로 확인 창 공급자를 이 화면에서 감싼다
export default function PasswordResetPage() {
  return (
    <ConfirmProvider>
      <PasswordResetPageInner />
    </ConfirmProvider>
  );
}

function PasswordResetPageInner() {
  const [step, setStep] = useState<Step>("find");
  const staff = useStaffType();
  const [unavailable, setUnavailable] = useState(false);
  const [email, setEmail] = useState("");
  const [shopSlug, setShopSlug] = useState("");
  const [idvKey, setIdvKey] = useState(0);
  const [notice, setNotice] = useState<{ title?: string; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 인증번호를 보낸 뒤에는 그 요청에 쓴 이메일·쇼핑몰 주소를 바꿀 수 없다(「정보 다시 입력」으로 풀린다)
  const [codeSent, setCodeSent] = useState(false);
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
      return;
    }
    const out = stepOutcome(r);
    if (out === "unavailable") return toUnavailable();
    // 결과를 아직 받는 중이거나 잠깐의 오류(연결 끊김·서버 오류): 본인확인을 버리지 않고 같은 요청으로 다시 누르게 한다
    if (r.error === "reset_not_allowed") {
      return restart(
        staff
          ? { title: "비밀번호를 변경할 수 없습니다", text: "등록된 직원 정보와 맞지 않습니다. 대표자에게 문의해 주십시오" }
          : { title: "비밀번호를 변경할 수 없습니다", text: "입력한 이메일과 쇼핑몰 주소가 맞는지, 대표자 본인 명의의 휴대폰인지 확인해 주십시오." },
      );
    }
    if (out === "restart") return restart({ text: "본인확인을 처음부터 다시 해 주십시오" });
    // 결과를 아직 받는 중이거나 그 밖의 오류(연결 끊김·서버 오류·요청 제한 등): 본인확인을 버리지 않고 같은 요청으로 다시 누르게 한다
    setPending(verificationId);
    setNotice({ text: r.error === "pending" ? "본인 확인 결과를 기다리는 중입니다. 잠시 뒤 「결과 다시 확인하기」를 눌러 주십시오" : failMessage(r, "admin", RETRY_TEXT) });
    focus("pa-notice");
  };

  const findReady = email.trim() !== "" && shopSlug.trim() !== "";

  return (
    <AuthFrame>
      {step === "done" ? (
        <div className="col" style={{ gap: 14, alignItems: "center", textAlign: "center" }}>
          <h1 className="t-t3" id="pa-done-title" tabIndex={-1}>
            비밀번호를 변경했습니다
          </h1>
          <span className="t-l2 c-alt">다른 기기의 로그인은 모두 해제되었습니다. 새 비밀번호로 로그인해 주십시오.</span>
          <Link className="btn btn-lg btn-block" href={withType("/seller/login", staff)}>
            로그인
          </Link>
        </div>
      ) : (
        <>
          {step === "find" && <FindSwitch current="password" />}
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">{step === "find" ? "비밀번호 찾기" : "새 비밀번호 설정"}</h1>
            <span className="t-l2 c-alt">
              {step === "find"
                ? "가입한 이메일과 쇼핑몰 주소를 입력하고 휴대폰으로 본인 확인을 하면 새 비밀번호를 정할 수 있습니다."
                : `${email.trim()} · 휴대폰 본인확인 완료`}
            </span>
          </div>
          {unavailable ? (
            <IdentityUnavailable tone="admin" action="비밀번호를 찾을" />
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
                        결과 다시 확인하기
                      </button>
                    </span>
                  )}
                </div>
              )}
              {step === "find" ? (
                <>
                  <div className="msg msg-info" style={{ display: "block" }}>
                    {staff ? "직원 본인 명의의 휴대폰으로 확인합니다." : "쇼핑몰 대표자 본인 명의의 휴대폰으로 확인합니다."}
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
                    <span className="help">가입할 때 정한 쇼핑몰 주소입니다</span>
                  </div>
                  <IdentityCheck tone="admin"
                    key={idvKey}
                    label="휴대폰 본인확인"
                    base={BASE}
                    blocked={!findReady || busy}
                    scope={JSON.stringify([email.trim(), shopSlug.trim(), staff])}
                    start={(person, attemptKey) => api<{ verificationId: string }>(`${BASE}/start`, { method: "POST", body: { email: email.trim(), shopSlug: shopSlug.trim(), person, attemptKey, accountType: staff ? "staff" : "owner" } })}
                    onUnavailable={toUnavailable}
                    onSentChange={setCodeSent}
                    onVerified={(id) => void verify(id)}
                  />
                </>
              ) : (
                <NewPasswordForm
                  loginHref={withType("/seller/login", staff)}
                  onDone={() => {
                    setStep("done");
                    focus("pa-done-title");
                  }}
                  onExpired={() => restart({ text: "시간이 지나 처음부터 다시 해야 합니다. 본인확인을 다시 해 주십시오" })}
                />
              )}
            </>
          )}
          {!unavailable && (
            <div className="row t-l2 c-alt" style={{ justifyContent: "center" }}>
              <Link href={withType("/seller/login", staff)}>로그인으로 돌아가기</Link>
            </div>
          )}
        </>
      )}
    </AuthFrame>
  );
}
