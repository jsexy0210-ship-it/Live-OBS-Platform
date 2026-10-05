"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import IdentityCheck from "../../../../components/seller/IdentityCheck";
import NewPasswordForm from "../../../../components/seller/NewPasswordForm";
import { AuthFrame, FindSwitch, IdentityUnavailable, useStaffType, withType } from "../../../../components/seller/PartnersAuth";
import { api, failMessage } from "../../../../components/seller/api";
import { RETRY_TEXT, stepOutcome } from "../../../../components/seller/stepFailure";

// AU-011 아이디 찾기(정본: docs/IA.md AU-011). 대표자·직원 본인 휴대폰 본인확인 → 맞는 계정의 로그인 이메일을 쇼핑몰 이름과 함께 모두 보여 준다.
// 하나를 고르면 그 계정만 비밀번호를 바꿀 수 있다(쇼핑몰 주소를 몰라도 됨, AU-003 → AU-004).
// API: POST /api/seller/find-id/start(·/resend·/confirm) → /accounts(목록, 본인확인 소진 안 함) → /reset(고른 계정 재설정 권한, 소진)
//      → /api/seller/password-reset/complete(새 비밀번호). 맞는 계정이 없으면 빈 목록이다(직원 미연결 포함).
// 로그인 화면 직원 탭에서 오면 ?type=staff이고 accountType만 다르게 보낸다.
const BASE = "/api/seller/find-id";

type Account = { accountId: string; shopName: string; shopSlug: string; email: string };
type Step = "find" | "accounts" | "password" | "done";

export default function FindIdPage() {
  const staff = useStaffType();
  const accountType = staff ? "staff" : "owner";
  const [step, setStep] = useState<Step>("find");
  const [unavailable, setUnavailable] = useState(false);
  const [idvKey, setIdvKey] = useState(0);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ title?: string; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
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

  // 처음부터 다시(본인확인 칸을 비운다)
  const restart = (n: { title?: string; text: string } | null) => {
    setStep("find");
    setVerificationId(null);
    setAccounts([]);
    setPicked(null);
    setPending(false);
    setIdvKey((k) => k + 1);
    setNotice(n);
    if (n) focus("pa-notice");
  };

  // 본인확인을 마치면 맞는 계정 목록을 받는다
  const loadAccounts = async (id: string) => {
    setBusy(true);
    setNotice(null);
    const r = await api<{ accounts: Account[] }>(`${BASE}/accounts`, { method: "POST", body: { verificationId: id, accountType } });
    setBusy(false);
    if (r.ok) {
      setPending(false);
      setVerificationId(id);
      setAccounts(r.data.accounts);
      setPicked(r.data.accounts.length === 1 ? r.data.accounts[0].accountId : null);
      setStep("accounts");
      return focus("fi-title");
    }
    const out = stepOutcome(r);
    if (out === "unavailable") return toUnavailable();
    if (out === "restart") return restart({ text: "본인확인을 처음부터 다시 해 주십시오" });
    // 결과를 아직 받는 중이거나 잠깐의 오류(연결 끊김·서버 오류 등): 본인확인을 버리지 않고 같은 요청으로 다시 누르게 한다
    setVerificationId(id);
    setPending(true);
    setNotice({ text: r.error === "pending" ? "본인확인 결과를 확인하고 있습니다. 잠시 후 다시 눌러 주십시오" : failMessage(r, "admin", RETRY_TEXT) });
    focus("pa-notice");
  };

  // 고른 계정의 비밀번호 재설정 권한을 받는다(본인확인은 여기서 소진된다)
  const reset = async () => {
    if (!verificationId || !picked || busy) return;
    setBusy(true);
    setNotice(null);
    const r = await api(`${BASE}/reset`, { method: "POST", body: { verificationId, accountType, accountId: picked } });
    setBusy(false);
    if (r.ok) return setStep("password");
    const out = stepOutcome(r);
    if (out === "unavailable") return toUnavailable();
    if (out === "restart") return restart({ text: "본인확인을 처음부터 다시 해 주십시오" });
    // 응답을 놓쳤거나(연결 끊김) 잠깐의 오류: 고른 계정을 그대로 두고 다시 누르게 한다(서버는 같은 본인확인의 재요청에 같은 권한을 돌려준다)
    setNotice({ text: failMessage(r, "admin", RETRY_TEXT) });
    focus("pa-notice");
  };

  const pickedAccount = accounts.find((a) => a.accountId === picked);
  const title = { find: "이메일(아이디) 찾기", accounts: accounts.length > 0 ? "가입한 계정을 찾았습니다" : "맞는 계정이 없습니다", password: "새 비밀번호 설정", done: "비밀번호를 변경했습니다" }[step];

  if (step === "done") {
    return (
      <AuthFrame>
        <div className="col" style={{ gap: 14, alignItems: "center", textAlign: "center" }}>
          <h1 className="t-t3" id="pa-done-title" tabIndex={-1}>
            {title}
          </h1>
          <span className="t-l2 c-alt">다른 기기의 로그인은 모두 해제되었습니다. 새 비밀번호로 로그인해 주십시오.</span>
          <Link className="btn btn-lg btn-block" href={withType("/seller/login", staff)}>
            로그인
          </Link>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      {step === "find" && <FindSwitch current="id" />}
      <div className="col" style={{ gap: 4 }}>
        <h1 className="t-t3" id="fi-title" tabIndex={-1}>
          {title}
        </h1>
        <span className="t-l2 c-alt">
          {step === "find"
            ? "휴대폰 본인확인을 하면 가입한 로그인 이메일을 알려 드립니다."
            : step === "password"
              ? `${pickedAccount?.shopName ?? ""} · ${pickedAccount?.email ?? ""}`
              : accounts.length > 0
                ? "로그인할 때 이 이메일을 사용합니다. 비밀번호를 변경하려면 계정을 선택해 주십시오."
                : staff
                  ? "등록된 직원 정보와 맞는 계정이 없습니다. 대표자에게 문의해 주십시오"
                  : "입력한 정보와 맞는 대표자 계정이 없습니다."}
        </span>
      </div>
      {unavailable ? (
        <IdentityUnavailable tone="admin" action="아이디를 찾을" />
      ) : (
        <>
          {notice && (
            <div id="pa-notice" tabIndex={-1} className="msg msg-neg" role="alert" style={{ display: "block" }}>
              {notice.title && <b style={{ display: "block", marginBottom: 4 }}>{notice.title}</b>}
              {notice.text}
              {pending && verificationId && (
                <span className="row" style={{ marginTop: 8 }}>
                  <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void loadAccounts(verificationId)}>
                    결과 다시 확인하기
                  </button>
                </span>
              )}
            </div>
          )}
          {step === "find" && (
            <>
              <div className="msg msg-info" style={{ display: "block" }}>
                {staff ? "직원 본인 명의의 휴대폰으로 확인합니다." : "쇼핑몰 대표자 본인 명의의 휴대폰으로 확인합니다."}
              </div>
              <IdentityCheck tone="admin"
                key={idvKey}
                label="휴대폰 본인확인"
                base={BASE}
                blocked={busy}
                scope={accountType}
                start={(person, attemptKey) => api<{ verificationId: string }>(`${BASE}/start`, { method: "POST", body: { ...person, attemptKey, accountType } })}
                onUnavailable={toUnavailable}
                onVerified={(id) => void loadAccounts(id)}
              />
            </>
          )}
          {step === "accounts" &&
            (accounts.length > 0 ? (
              <>
                <div className="col" role="radiogroup" aria-label="계정" style={{ gap: 8 }}>
                  {accounts.map((a) => (
                    <label key={a.accountId} className={`choice col${picked === a.accountId ? " on" : ""}`} style={{ gap: 2 }} data-testid="fi-account">
                      <span className="row" style={{ gap: 8 }}>
                        <input type="radio" name="fi-account" checked={picked === a.accountId} onChange={() => setPicked(a.accountId)} />
                        <span className="fw7">{a.shopName}</span>
                      </span>
                      <span className="t-l2" style={{ paddingLeft: 24 }}>
                        {a.email}
                      </span>
                    </label>
                  ))}
                </div>
                <Link className="btn btn-lg btn-block" href={withType("/seller/login", staff)}>
                  로그인
                </Link>
                <button className={`btn btn-lg btn-block btn-out${busy ? " is-loading" : ""}`} type="button" disabled={!picked || busy} onClick={() => void reset()}>
                  {busy ? "확인하는 중" : "선택한 계정의 비밀번호 바꾸기"}
                </button>
              </>
            ) : (
              <button className="btn btn-lg btn-block btn-out" type="button" onClick={() => restart(null)}>
                본인확인 다시 하기
              </button>
            ))}
          {step === "password" && (
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
        <div className="row t-l2 c-alt" style={{ justifyContent: "center", gap: 8 }}>
          <Link href={withType("/seller/login", staff)}>로그인으로 돌아가기</Link>
        </div>
      )}
    </AuthFrame>
  );
}
