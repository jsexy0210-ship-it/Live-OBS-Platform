"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";

// SA-120 내 계정. 이름 변경과 비밀번호 변경은 본인 것만 다룬다(대상 id 없음). 첫 결제 전·잠김·이용 정지 중에도 쓴다.
// API: PATCH /api/seller/me/name { name ≤50 } → { ok, name } | 400 invalid_name.
// POST /api/seller/me/password { currentPassword, newPassword(8~200), signOutOthers(필수 true/false) } → { ok, signedOutOthers, signedOutSessions }
//   | 400 bad_request·weak_password·same_password·wrong_password·changed_elsewhere { message } | 429 rate_limited { message, retryAfterSeconds }.
// GET /api/seller/me/identity: 직원의 본인확인 연결 상태(대표자는 403이라 이 줄을 숨긴다).
type Identity = { available: boolean; linked: boolean; relinkRequired: boolean; registeredPhoneLast4: string | null };
type Choice = "" | "yes" | "no";

export default function AccountPage() {
  const { me } = useSeller();
  const [name, setName] = useState(me?.user.name ?? "");
  const [savedName, setSavedName] = useState(me?.user.name ?? "");
  const [nameErr, setNameErr] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [choice, setChoice] = useState<Choice>("");
  const [pwErr, setPwErr] = useState("");
  const [choiceErr, setChoiceErr] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void api<Identity>("/api/seller/me/identity").then((r) => r.ok && setIdentity(r.data));
  }, []);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nameBusy) return;
    setNameErr("");
    setNameBusy(true);
    const r = await api<{ name: string }>("/api/seller/me/name", { method: "PATCH", body: { name } });
    setNameBusy(false);
    if (r.ok) {
      setName(r.data.name);
      setSavedName(r.data.name);
      return setToast("이름을 저장했습니다");
    }
    setNameErr(r.message ?? "이름을 저장하지 못했습니다. 잠시 후 다시 시도해 주십시오");
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwBusy || wait > 0) return;
    setPwErr("");
    setChoiceErr("");
    if (choice === "") return setChoiceErr("다른 곳에서 로그아웃할지 선택해 주십시오");
    setPwBusy(true);
    const r = await api<{ signedOutSessions: number }>("/api/seller/me/password", {
      method: "POST",
      body: { currentPassword: cur, newPassword: next, signOutOthers: choice === "yes" },
    });
    setPwBusy(false);
    if (r.ok) {
      setCur("");
      setNext("");
      setChoice("");
      return setToast("비밀번호를 변경했습니다");
    }
    if (r.status === 429) {
      const sec = Number((r.body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds);
      setWait(Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : 60);
    }
    setPwErr(r.message ?? "비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도해 주십시오");
  };

  const locked = wait > 0;
  return (
    <>
      <Topbar crumb="내 계정" />
      <main className="main">
        <PageHead title="내 계정" />
        <div className="col" style={{ gap: 16, maxWidth: 640 }}>
          <section className="card pad-l col" style={{ gap: 12 }} data-testid="account-info">
            <h2 className="t-hl1">계정 정보</h2>
            <dl className="col" style={{ gap: 6 }}>
              <div className="row" style={{ gap: 12 }}>
                <dt className="t-l2 c-alt" style={{ width: 88 }}>
                  이메일
                </dt>
                <dd className="t-b1">{me?.user.email}</dd>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <dt className="t-l2 c-alt" style={{ width: 88 }}>
                  쇼핑몰
                </dt>
                <dd className="t-b1">{me?.shop.name}</dd>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <dt className="t-l2 c-alt" style={{ width: 88 }}>
                  구분
                </dt>
                <dd className="t-b1">{me?.isOwner ? "대표자" : "직원"}</dd>
              </div>
              {identity && (
                <div className="row" style={{ gap: 12 }} data-testid="account-identity">
                  <dt className="t-l2 c-alt" style={{ width: 88 }}>
                    본인확인
                  </dt>
                  <dd className="t-b1">
                    {identity.linked ? (
                      "연결됨"
                    ) : identity.available ? (
                      <>
                        {identity.relinkRequired ? "휴대폰이 바뀌어 다시 연결해야 합니다. " : "연결하지 않았습니다. "}
                        <Link href="/seller/identity-link">연결</Link>
                      </>
                    ) : (
                      "지금은 연결할 수 없습니다"
                    )}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <form className="card pad-l col" style={{ gap: 14 }} onSubmit={saveName} noValidate data-testid="account-name-form">
            <h2 className="t-hl1">이름 변경</h2>
            <div className="fld">
              <label htmlFor="acc-name" className="req">
                이름
              </label>
              <input id="acc-name" className={`inp${nameErr ? " is-error" : ""}`} value={name} maxLength={50} aria-invalid={!!nameErr} aria-describedby={nameErr ? "acc-name-err" : undefined} onChange={(e) => setName(e.target.value)} />
              {nameErr && (
                <span id="acc-name-err" className="err" role="alert">
                  {nameErr}
                </span>
              )}
            </div>
            <div>
              <button className="btn" type="submit" disabled={nameBusy || name.trim() === "" || name === savedName}>
                저장
              </button>
            </div>
          </form>

          <form className="card pad-l col" style={{ gap: 14 }} onSubmit={savePassword} noValidate data-testid="account-password-form">
            <h2 className="t-hl1">비밀번호 변경</h2>
            <div className="fld">
              <label htmlFor="acc-cur" className="req">
                현재 비밀번호
              </label>
              <input id="acc-cur" className="inp" type="password" autoComplete="current-password" value={cur} disabled={locked} onChange={(e) => setCur(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="acc-new" className="req">
                새 비밀번호
              </label>
              <input id="acc-new" className="inp" type="password" autoComplete="new-password" value={next} disabled={locked} onChange={(e) => setNext(e.target.value)} />
              <span className="help">8자 이상 입력해 주십시오</span>
            </div>
            <fieldset className="fld" aria-describedby={choiceErr ? "acc-choice-err" : undefined} style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="req" style={{ padding: 0 }}>
                다른 곳에서 로그아웃
              </legend>
              <div className="row" style={{ gap: 16 }}>
                <label className="row" style={{ gap: 6 }}>
                  <input type="radio" name="acc-signout" checked={choice === "yes"} disabled={locked} onChange={() => setChoice("yes")} />
                  로그아웃
                </label>
                <label className="row" style={{ gap: 6 }}>
                  <input type="radio" name="acc-signout" checked={choice === "no"} disabled={locked} onChange={() => setChoice("no")} />
                  유지
                </label>
              </div>
              {choiceErr && (
                <span id="acc-choice-err" className="err" role="alert">
                  {choiceErr}
                </span>
              )}
            </fieldset>
            {pwErr && (
              <span className="err" role="alert" data-testid="account-pw-error">
                {pwErr}
              </span>
            )}
            {locked && (
              <span className="t-l2 c-alt" data-testid="account-pw-wait">
                {wait}초 뒤에 다시 시도할 수 있습니다
              </span>
            )}
            <div>
              <button className="btn" type="submit" disabled={pwBusy || locked || cur === "" || next === ""}>
                비밀번호 변경
              </button>
            </div>
          </form>
        </div>
        {toast && <Toast text={toast} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
