"use client";

import "../../../../../styles/seller-account.css";
import { useEffect, useState } from "react";
import { PageHead } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";

// SA-120 내 계정. 디자인 정본 design/project/SA-120.dc.html(v256, DRAFT — MASTER 승인 2026-10-06 00:00 KST, 정본 구조 기준)의 2열 구성 중
// 서버 API가 있는 영역만 만든다: 프로필(이름 변경) · 비밀번호 변경. 연락처·알림 수신·로그인 기기/세션은 API가 생길 때 후속으로 넣는다(오른쪽 열).
// 첫 결제 전·잠김·이용 정지 중에도 쓴다.
// API: PATCH /api/seller/me/name { name ≤50 } → { ok, name } | 400 invalid_name { message }.
// POST /api/seller/me/password { currentPassword, newPassword(8~200), signOutOthers } → { ok } | 400 bad_request·weak_password·same_password·wrong_password·changed_elsewhere { message }
//   | 429 rate_limited { message, retryAfterSeconds }. 정본대로 변경하면 이 세션만 남기고 다른 곳은 항상 로그아웃한다(signOutOthers: true).
export default function AccountPage() {
  const { me } = useSeller();
  const [name, setName] = useState(me?.user.name ?? "");
  const [nameErr, setNameErr] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [curErr, setCurErr] = useState("");
  const [nextErr, setNextErr] = useState("");
  const [againErr, setAgainErr] = useState("");
  const [pwErr, setPwErr] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [wait, setWait] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  const logout = async () => {
    const r = await api("/api/seller/auth/logout", { method: "POST" });
    if (r.ok) window.location.assign("/seller/login");
    else setToast("로그아웃하지 못했습니다. 다시 시도해 주십시오");
  };

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (nameBusy) return;
    setNameErr("");
    if (name.trim() === "") return setNameErr("이름을 입력해 주십시오");
    setNameBusy(true);
    const r = await api<{ name: string }>("/api/seller/me/name", { method: "PATCH", body: { name } });
    setNameBusy(false);
    if (r.ok) {
      setName(r.data.name);
      return setToast("프로필을 저장했습니다");
    }
    setNameErr(r.message ?? "이름을 저장하지 못했습니다. 잠시 후 다시 시도해 주십시오");
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pwBusy || wait > 0) return;
    setCurErr("");
    setNextErr("");
    setAgainErr("");
    setPwErr("");
    if (cur === "") return setCurErr("현재 비밀번호를 입력해 주십시오");
    if (next === "") return setNextErr("새 비밀번호를 입력해 주십시오");
    if (next !== again) return setAgainErr("새 비밀번호가 서로 다릅니다");
    setPwBusy(true);
    const r = await api("/api/seller/me/password", { method: "POST", body: { currentPassword: cur, newPassword: next, signOutOthers: true } });
    setPwBusy(false);
    if (r.ok) {
      setCur("");
      setNext("");
      setAgain("");
      return setToast("비밀번호를 변경했습니다");
    }
    const message = r.message ?? "비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도해 주십시오";
    if (r.status === 429) {
      const sec = Number((r.body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds);
      setWait(Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : 60);
      return setPwErr(message);
    }
    if (r.error === "wrong_password") return setCurErr(message);
    if (r.error === "weak_password" || r.error === "same_password") return setNextErr(message);
    setPwErr(message);
  };

  const locked = wait > 0;
  return (
    <>
      <Topbar crumb="내 계정" />
      <main className="main">
        <PageHead
          title="내 계정"
          actions={
            <button className="btn btn-out" type="button" onClick={() => void logout()}>
              로그아웃
            </button>
          }
        />
        <div className="acc-two">
          <div>
            <div className="acc-sec-t">프로필</div>
            <form onSubmit={saveName} noValidate data-testid="account-name-form">
              <table className="au-ft" data-testid="account-info">
                <tbody>
                  <tr>
                    <th scope="row">계정</th>
                    <td>
                      <b>{me?.shop.name}</b> · 파트너스 ({me?.isOwner ? "대표자" : "직원"})
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      <label htmlFor="acc-name">이름</label>
                    </th>
                    <td>
                      <input id="acc-name" className={`inp acc-in${nameErr ? " is-error" : ""}`} value={name} maxLength={50} aria-invalid={!!nameErr} aria-describedby={nameErr ? "acc-name-err" : undefined} onChange={(e) => setName(e.target.value)} />
                      {nameErr && (
                        <span id="acc-name-err" className="err" role="alert">
                          {nameErr}
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">로그인 이메일</th>
                    <td>
                      {me?.user.email} <span className="t-l2 c-alt">· 변경은 문의하기로</span>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">언어 · 시간대</th>
                    <td>한국어 · Asia/Seoul</td>
                  </tr>
                  <tr>
                    <th scope="row" />
                    <td>
                      <button className="btn btn-sm" type="submit" disabled={nameBusy}>
                        저장
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </form>

            <div className="acc-sec-t">비밀번호 변경</div>
            <form onSubmit={savePassword} noValidate data-testid="account-password-form">
              <table className="au-ft">
                <tbody>
                  <tr>
                    <th scope="row">
                      <label htmlFor="acc-cur">현재 비밀번호</label> <span aria-hidden="true">*</span>
                    </th>
                    <td>
                      <input id="acc-cur" className={`inp acc-in${curErr ? " is-error" : ""}`} type="password" autoComplete="current-password" value={cur} disabled={locked} aria-invalid={!!curErr} onChange={(e) => setCur(e.target.value)} />
                      {curErr && (
                        <span className="err" role="alert" data-testid="account-cur-error">
                          {curErr}
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      <label htmlFor="acc-new">새 비밀번호</label> <span aria-hidden="true">*</span>
                    </th>
                    <td>
                      <input id="acc-new" className={`inp acc-in${nextErr ? " is-error" : ""}`} type="password" autoComplete="new-password" value={next} disabled={locked} aria-invalid={!!nextErr} onChange={(e) => setNext(e.target.value)} />
                      {nextErr ? (
                        <span className="err" role="alert" data-testid="account-new-error">
                          {nextErr}
                        </span>
                      ) : (
                        <span className="help">8자 이상 입력해 주십시오</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      <label htmlFor="acc-again">새 비밀번호 확인</label> <span aria-hidden="true">*</span>
                    </th>
                    <td>
                      <input id="acc-again" className={`inp acc-in${againErr ? " is-error" : ""}`} type="password" autoComplete="new-password" value={again} disabled={locked} aria-invalid={!!againErr} onChange={(e) => setAgain(e.target.value)} />
                      {againErr && (
                        <span className="err" role="alert">
                          {againErr}
                        </span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row" />
                    <td>
                      <button className="btn btn-sm" type="submit" disabled={pwBusy || locked}>
                        비밀번호 변경
                      </button>
                      <span className="help">변경 시 다른 기기에서 로그아웃됩니다</span>
                      {pwErr && (
                        <span className="err" role="alert" data-testid="account-pw-error">
                          {pwErr}
                        </span>
                      )}
                      {locked && (
                        <span className="help" data-testid="account-pw-wait">
                          {wait}초 뒤에 다시 시도할 수 있습니다
                        </span>
                      )}
                    </td>
                  </tr>
                </tbody>
              </table>
            </form>
          </div>
          <div />
        </div>
        {toast && <Toast text={toast} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
