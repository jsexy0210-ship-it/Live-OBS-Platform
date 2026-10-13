"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import MarketingConsentDoc from "../MarketingConsentDoc";
import ShopState from "../ShopState";
import TestModeNotice from "../../seller/TestModeNotice";
import { CARRIERS, digits, phoneText, STEP_LABEL, STEP_ORDER, useSignup, useStepGuard, MAX_NICKNAME_LENGTH, type Carrier, type StepKey } from "./SignupFlow";
import "./Signup.css";

// SH-011 회원가입 4단계 화면(보드 SH-011-1~4). 상태·서버 호출은 SignupFlow가 들고, 여기는 단계별 화면만 그린다.

// 단계 화면이 열리면 이어서 할 칸으로 포커스를 옮긴다
function AutoFocus({ id }: { id: string }) {
  useEffect(() => {
    document.getElementById(id)?.focus();
  }, [id]);
  return null;
}

function Progress({ step }: { step: StepKey }) {
  const idx = STEP_ORDER.indexOf(step);
  return (
    <div className="sg-progress" role="group" aria-label={`가입 단계 ${idx + 1} / 4`}>
      <b className="sg-count">
        {idx + 1} / 4
      </b>
      <ol>
        {STEP_ORDER.map((s, i) => (
          <li key={s} className={i < idx ? "is-done" : i === idx ? "is-now" : ""} aria-current={i === idx ? "step" : undefined}>
            <span className="sg-dot">{i + 1}</span>
            {i === idx && <span className="sg-label">{STEP_LABEL[s]}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Shell({ step, title, sub, children }: { step: StepKey; title: string; sub: string; children: React.ReactNode }) {
  const f = useSignup();
  const hold = useStepGuard(step);
  if (f.blocked) return <ShopState title="지금은 가입할 수 없어요" body="쇼핑몰에 문의해 주세요." />;
  if (hold) {
    return (
      <div className="card shop-card sg-card" aria-busy="true">
        <span className="t-l1 c-alt">불러오고 있어요</span>
      </div>
    );
  }
  return (
    <div className="card shop-card col sg-card">
      <div className="col" style={{ gap: 4 }}>
        <h1 className="t-t3">{title}</h1>
        <span className="t-l2 c-alt">{sub}</span>
      </div>
      <Progress step={step} />
      {f.guardNotice && (
        <div className="msg msg-info" role="status">
          {f.guardNotice}
        </div>
      )}
      {f.notice && (
        <div id="signup-notice" tabIndex={-1} className={`msg msg-${f.notice.kind}`} role={f.notice.kind === "neg" ? "alert" : "status"}>
          <span className="grow">{f.notice.text}</span>
          {(f.unconfirmed || f.resultPending) && (
            <button type="button" className="btn btn-sm btn-out" disabled={f.busy} onClick={f.unconfirmed ? f.retry : f.loadVerified}>
              다시 불러오기
            </button>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

// ── 1단계 약관 동의 ──
export function TermsStep() {
  const f = useSignup();
  const [open, setOpen] = useState<null | "age" | "marketing" | "rejoin">(null);
  const all = f.terms && f.privacy && f.age14 && f.marketing;
  const toggleAll = (v: boolean) => {
    f.setTermsTouched(true);
    f.setTerms(v);
    f.setPrivacy(v);
    f.setAge14(v);
    f.setMarketing(v);
  };
  const row = (checked: boolean, set: (v: boolean) => void, label: string, view: React.ReactNode, id: string) => (
    <div className="sg-chk">
      <label className="chk">
        <input
          id={id}
          type="checkbox"
          className="cbx"
          checked={checked}
          onChange={(e) => {
            f.setTermsTouched(true);
            set(e.target.checked);
          }}
        />
        {label}
      </label>
      {view}
    </div>
  );
  // 화면을 연 뒤 동의 문서가 바뀌었으면 새로고침 버튼으로 포커스를 옮긴다
  const needsReload = f.needsReload;
  const focus = f.focus;
  useEffect(() => {
    if (needsReload) focus("idv-reload");
  }, [needsReload, focus]);
  return (
    <Shell step="terms" title="회원가입" sub="휴대폰 본인확인으로 가입해요 · 4단계">
      <div className="sg-terms">
        <label className="chk sg-all">
          <input id="sg-all" type="checkbox" className="cbx" checked={all} onChange={(e) => toggleAll(e.target.checked)} />
          모두 동의해요
        </label>
        {row(f.terms, f.setTerms, "이용약관 동의 (필수)", <Link className="sg-view" href={`${f.home}/terms`} target="_blank">보기</Link>, "sg-terms")}
        {row(f.privacy, f.setPrivacy, "개인정보 수집 · 이용 동의 (필수)", <Link className="sg-view" href={`${f.home}/privacy`} target="_blank">보기</Link>, "sg-privacy")}
        {row(
          f.age14,
          f.setAge14,
          "만 14세 이상이에요 (필수)",
          <button type="button" className="sg-view" aria-expanded={open === "age"} onClick={() => setOpen(open === "age" ? null : "age")}>
            보기
          </button>,
          "sg-age",
        )}
        {open === "age" && <p className="sg-doc">만 14세 미만은 가입할 수 없어요. 나이는 휴대폰 본인확인의 생년월일로 확인해요.</p>}
        {row(
          f.marketing,
          f.setMarketing,
          "방송 · 혜택 알림 받기 (선택)",
          <button type="button" className="sg-view" aria-expanded={open === "marketing"} onClick={() => setOpen(open === "marketing" ? null : "marketing")}>
            보기
          </button>,
          "sg-marketing",
        )}
        {open === "marketing" && (
          <div className="sg-doc">
            <MarketingConsentDoc shopName={f.shopName} />
          </div>
        )}
      </div>
      {f.termsTouched && !f.termsOk && (
        <div className="msg msg-neg" role="alert">
          필수 약관에 동의해 주세요
        </div>
      )}
      {f.needsReload && (
        <div className="msg msg-cau" role="alert" data-testid="idv-reload-box">
          <span>
            <b>새로고침이 필요해요.</b> 동의 내용이 바뀌었어요. 새로고침한 뒤 바뀐 내용을 확인하고 동의해 주세요.
          </span>
          <span className="row" style={{ marginTop: 8 }}>
            <button id="idv-reload" className="btn btn-sm" type="button" onClick={() => window.location.reload()}>
              새로고침
            </button>
          </span>
        </div>
      )}
      <p className="help">다음 단계는 휴대폰 본인확인이에요 · 배송지는 가입 때 받지 않고 첫 주문 때 입력해요</p>
      <div className="sg-btns">
        <Link className="btn btn-lg btn-out" href={f.home}>
          취소
        </Link>
        <button type="button" className="btn btn-lg" disabled={!f.termsOk || f.needsReload} onClick={() => f.go("verify")}>
          다음
        </button>
      </div>
      <p className="sg-login">
        이미 회원이에요? <Link href={`${f.home}/login${f.next ? `?next=${encodeURIComponent(f.next)}` : ""}`}>로그인</Link>
      </p>
    </Shell>
  );
}

// ── 2단계 휴대폰 본인확인 ──
export function VerifyStep() {
  const f = useSignup();
  const locked = f.codeStage || f.verified !== null || f.busy || !f.identityReady || f.unavailable;
  const stopped = !f.identityReady || f.unavailable;
  return (
    <Shell step="verify" title="회원가입" sub="본인 명의 휴대폰으로 확인해요">
      {stopped && (
        <div className="msg msg-cau" role="status">
          <b>지금은 가입할 수 없어요.</b> 휴대폰 본인확인 서비스를 준비하고 있어요. 준비되면 알려 드릴게요.
        </div>
      )}
      <TestModeNotice kind="identity" />
      {f.verified === null ? (
        <form
          className="col sg-form"
          aria-label="본인확인"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void f.sendCode();
          }}
        >
          <div className="fld">
            <label htmlFor="idv-name">
              이름<i aria-hidden="true">*</i>
            </label>
            <input id="idv-name" className="inp" autoComplete="name" placeholder="본인 이름" value={f.name} disabled={locked} onChange={(e) => f.setName(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="idv-birth">
              생년월일<i aria-hidden="true">*</i>
            </label>
            <input
              id="idv-birth"
              className={`inp${f.birthError ? " is-error" : ""}`}
              inputMode="numeric"
              placeholder="예: 19990101"
              value={f.birth}
              disabled={locked}
              onChange={(e) => {
                f.setBirth(digits(e.target.value, 8));
                f.setBirthError(null);
              }}
              aria-invalid={!!f.birthError}
              aria-describedby={f.birthError ? "idv-birth-err" : "idv-birth-help"}
            />
            {f.birthError ? (
              <span id="idv-birth-err" className="err" role="alert">
                {f.birthError}
              </span>
            ) : (
              <span id="idv-birth-help" className="help">
                숫자 8자리
              </span>
            )}
          </div>
          <div className="signup-two">
            <div className="fld">
              <span className="lbl" id="idv-gender">
                성별
              </span>
              <div className="seg signup-seg" role="group" aria-labelledby="idv-gender">
                {(["M", "F"] as const).map((g) => (
                  <button key={g} type="button" className={f.gender === g ? "on" : ""} aria-pressed={f.gender === g} disabled={locked} onClick={() => f.setGender(g)}>
                    {g === "M" ? "남" : "여"}
                  </button>
                ))}
              </div>
            </div>
            <div className="fld">
              <span className="lbl" id="idv-nation">
                내·외국인
              </span>
              <div className="seg signup-seg" role="group" aria-labelledby="idv-nation">
                {[false, true].map((x) => (
                  <button key={String(x)} type="button" className={f.foreigner === x ? "on" : ""} aria-pressed={f.foreigner === x} disabled={locked} onClick={() => f.setForeigner(x)}>
                    {x ? "외국인" : "내국인"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="fld">
            <label htmlFor="idv-carrier">
              통신사<i aria-hidden="true">*</i>
            </label>
            <select id="idv-carrier" className="inp" value={f.carrier} disabled={locked} onChange={(e) => f.setCarrier(e.target.value as Carrier)}>
              <option value="" disabled>
                통신사 선택
              </option>
              {CARRIERS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="idv-phone">
              휴대폰번호<i aria-hidden="true">*</i>
            </label>
            <input id="idv-phone" className="inp" inputMode="numeric" autoComplete="tel-national" placeholder="숫자만 입력" value={f.phone} disabled={locked} onChange={(e) => f.setPhone(digits(e.target.value, 11))} />
          </div>
          <label className="chk">
            <input id="idv-agree" type="checkbox" className="cbx" checked={f.idvAgreed} disabled={locked} onChange={(e) => f.setIdvAgreed(e.target.checked)} />
            본인확인 이용 약관에 모두 동의해요
          </label>
          {f.rejoinShown && (
            <>
              <label className="chk">
                <input type="checkbox" className="cbx" checked={f.rejoin} disabled={locked} onChange={(e) => f.setRejoin(e.target.checked)} />
                재가입 제한 정보 보관 (선택)
              </label>
              {/* 본문: docs/terms/PRIVACY_CONSENT_TEMPLATE.md 하단 「재가입 제한 정보 보관 동의」 */}
              <details className="signup-terms-doc">
                <summary>보기</summary>
                <p>탈퇴한 회원이 정해진 기간 안에 다시 가입하지 못하게 하려고 아래 정보를 보관해요.</p>
                <ul>
                  <li>보관 목적: 탈퇴 회원의 재가입 제한</li>
                  <li>보관 항목: 본인 확인 때 받은 정보를 알아볼 수 없는 값으로 바꾼 것</li>
                  <li>보관 기간: 탈퇴한 날부터 {f.consent.rejoinDays}일</li>
                </ul>
                <p>동의하지 않아도 가입할 수 있어요. 동의하지 않으면 이 정보를 보관하지 않고, 탈퇴한 뒤 다시 가입할 때 기간 제한을 받지 않아요.</p>
              </details>
            </>
          )}
          {!f.codeStage && (
            <>
              <button className={`btn btn-lg btn-block${f.busy ? " is-loading" : ""}`} type="submit" disabled={!f.identityFilled || f.busy || stopped}>
                {f.busy ? "인증번호를 보내고 있어요" : "인증번호 문자 받기"}
              </button>
              {!f.busy && !stopped && f.identityMissing.length > 0 && (
                <p className="help signup-missing" id="idv-missing" role="status">
                  아직 입력하지 않은 것: {f.identityMissing.join(" · ")}
                </p>
              )}
              <p className="help">본인 명의 휴대폰으로 확인해요 · 이름 · 생년월일 · 번호가 가입 정보에 들어가고 바꿀 수 없어요 · 같은 휴대폰으로는 이 쇼핑몰에 한 번만 가입할 수 있어요</p>
            </>
          )}
        </form>
      ) : (
        <section className="sg-verified" aria-label="본인확인 결과">
          <span className="bdg b-done">본인확인 완료</span>
          <span className="sg-verified-text">
            <b>
              {f.verified.name} · {phoneText(f.verified.phone)}
              {f.birth.length === 8 ? ` · ${f.birth.slice(0, 4)}년생` : ""}
            </b>
            <span className="c-alt">방금 확인했어요 · 바꿀 수 없어요</span>
          </span>
          <button type="button" className="btn btn-sm btn-out" disabled={f.busy} onClick={() => f.restart(null)}>
            다시 하기
          </button>
        </section>
      )}
      {f.codeStage && (
        <div className="col sg-code">
          <div className="fld">
            <label htmlFor="idv-code">
              인증번호<i aria-hidden="true">*</i>
            </label>
            <input
              id="idv-code"
              className={`inp${f.codeError ? " is-error" : ""}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="6자리"
              value={f.code}
              onChange={(e) => {
                f.setCode(digits(e.target.value, 6));
                f.setCodeError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void f.confirm();
                }
              }}
              aria-invalid={!!f.codeError}
              aria-describedby={f.codeError ? "idv-code-err" : "idv-code-help"}
            />
            {f.codeError ? (
              <span id="idv-code-err" className="err" role="alert">
                {f.codeError}
              </span>
            ) : (
              <span id="idv-code-help" className="help">
                못 받았으면 「다시 받기」를 눌러 주세요
              </span>
            )}
          </div>
          <div className="sg-btns">
            <button type="button" className="btn btn-lg btn-out" disabled={f.busy} onClick={() => void f.resend()}>
              다시 받기
            </button>
            <button type="button" className="btn btn-lg" disabled={f.code.length !== 6 || f.busy} onClick={() => void f.confirm()}>
              인증번호 확인하기
            </button>
          </div>
          <button type="button" className="btn btn-sm btn-text" disabled={f.busy} onClick={() => f.restart(null)}>
            정보 다시 입력
          </button>
        </div>
      )}
      <div className="sg-btns">
        <button type="button" className="btn btn-lg btn-out" disabled={f.busy} onClick={() => f.go("terms")}>
          이전 단계
        </button>
        <button id="sg-next" type="button" className="btn btn-lg" disabled={f.verified === null || f.busy} onClick={() => f.go("account")}>
          다음
        </button>
      </div>
      <p className="help">입력한 내용은 새로고침하거나 뒤로 가도 남아 있어요(비밀번호는 빼고) · 이전 단계로 돌아가도 그대로예요</p>
    </Shell>
  );
}

// ── 3단계 정보 입력 ──
export function AccountStep() {
  const f = useSignup();
  const nickError = f.nicknameTooLong ? `닉네임은 ${MAX_NICKNAME_LENGTH}자까지 쓸 수 있어요` : f.fieldErrors.nickname;
  const who = f.verified;
  return (
    <Shell step="account" title="회원가입" sub="로그인에 쓸 정보만 입력해요">
      <AutoFocus id="acc-id" />
      {who && (
        <section className="sg-verified" aria-label="본인확인 결과">
          <span className="bdg b-done">본인확인 완료</span>
          <span className="sg-verified-text">
            <b>
              {who.name} · {phoneText(who.phone)}
              {f.birth.length === 8 ? ` · ${f.birth.slice(0, 4)}년생` : ""}
            </b>
            <span className="c-alt">휴대폰 본인확인으로 이름 · 생년월일 · 번호를 받았어요 · 바꿀 수 없어요</span>
          </span>
        </section>
      )}
      <form
        className="col sg-form"
        aria-label="계정 정보"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void f.signup();
        }}
      >
        <fieldset className="col signup-fs" disabled={f.busy || f.unconfirmed !== null}>
          <div className="fld">
            <label htmlFor="acc-id">
              아이디 (이메일)<i aria-hidden="true">*</i>
            </label>
            <input
              id="acc-id"
              className={`inp${f.fieldErrors.loginId ? " is-error" : ""}`}
              type="email"
              autoComplete="username"
              placeholder="example@email.com"
              value={f.loginId}
              onChange={(e) => f.setLoginId(e.target.value)}
              aria-invalid={!!f.fieldErrors.loginId}
              aria-describedby={f.fieldErrors.loginId ? "acc-id-err" : "acc-id-help"}
            />
            {f.fieldErrors.loginId ? (
              <span id="acc-id-err" className="err" role="alert">
                {f.fieldErrors.loginId}
                {f.fieldErrors.loginId.includes("이미 가입") && (
                  <>
                    {" "}
                    <Link href={`${f.home}/login`}>로그인</Link>
                  </>
                )}
              </span>
            ) : (
              <span id="acc-id-help" className="help">
                주문 · 배송 안내 메일을 받는 주소예요
              </span>
            )}
          </div>
          <div className="fld">
            <label htmlFor="acc-pw">
              비밀번호<i aria-hidden="true">*</i>
            </label>
            <input
              id="acc-pw"
              className={`inp${f.fieldErrors.password ? " is-error" : ""}`}
              type="password"
              autoComplete="new-password"
              value={f.password}
              onChange={(e) => f.setPassword(e.target.value)}
              aria-invalid={!!f.fieldErrors.password}
              aria-describedby={f.fieldErrors.password ? "acc-pw-err" : "acc-pw-help"}
            />
            {f.fieldErrors.password ? (
              <span id="acc-pw-err" className="err" role="alert">
                {f.fieldErrors.password}
              </span>
            ) : (
              <span id="acc-pw-help" className="help">
                8자 이상 · 영문과 숫자를 섞어 주세요
              </span>
            )}
          </div>
          <div className="fld">
            <label htmlFor="acc-pw2">
              비밀번호 확인<i aria-hidden="true">*</i>
            </label>
            <input
              id="acc-pw2"
              className={`inp${f.passwordMismatch ? " is-error" : ""}`}
              type="password"
              autoComplete="new-password"
              value={f.password2}
              onChange={(e) => f.setPassword2(e.target.value)}
              aria-invalid={f.passwordMismatch}
              aria-describedby={f.passwordMismatch ? "acc-pw2-err" : undefined}
            />
            {f.passwordMismatch && (
              <span id="acc-pw2-err" className="err" role="alert">
                비밀번호가 서로 달라요
              </span>
            )}
          </div>
          <div className="fld">
            <label htmlFor="acc-nick">
              방송 닉네임<i aria-hidden="true">*</i>
            </label>
            <input
              id="acc-nick"
              className={`inp${nickError ? " is-error" : ""}`}
              value={f.nickname}
              onChange={(e) => f.setNickname(e.target.value)}
              aria-invalid={!!nickError}
              aria-describedby={nickError ? "acc-nick-err" : "acc-nick-help"}
            />
            {nickError ? (
              <span id="acc-nick-err" className="err" role="alert">
                {nickError}
              </span>
            ) : (
              <span id="acc-nick-help" className="help">
                방송 화면에 보이는 이름이에요. 실명은 쓰지 마세요.
              </span>
            )}
          </div>
          <p className="help">로그인에 꼭 필요한 정보만 받아요 · 배송지는 첫 주문 때 입력해요</p>
          {!f.busy && f.accountMissing.length > 0 && (
            <p className="help signup-missing" id="acc-missing" role="status">
              아직 입력하지 않은 것: {f.accountMissing.join(" · ")}
            </p>
          )}
          <div className="sg-btns">
            <button
              type="button"
              className="btn btn-lg btn-out"
              disabled={f.busy}
              onClick={() => {
                f.setPassword("");
                f.setPassword2("");
                f.go("verify");
              }}
            >
              이전 단계
            </button>
            <button className={`btn btn-lg${f.busy ? " is-loading" : ""}`} type="submit" disabled={!f.accountReady || f.busy}>
              {f.busy ? "가입하고 있어요" : "가입하기"}
            </button>
          </div>
        </fieldset>
      </form>
    </Shell>
  );
}

// ── 4단계 가입 완료 ──
export function DoneStep() {
  const f = useSignup();
  return (
    <Shell step="done" title="회원가입" sub="가입이 끝났어요">
      <AutoFocus id="shop-state-title" />
      <div className="sg-done">
        <span className="shop-state-ico is-done" aria-hidden />
        <h2 id="shop-state-title" className="t-h1" tabIndex={-1}>
          가입했어요
        </h2>
        <p className="t-l1 c-alt">
          {f.joinedNickname ? `방송에서는 ${f.joinedNickname} 닉네임으로 보여요 · ` : ""}첫 주문부터 적립돼요 · 배송지는 첫 주문 때 입력해요
        </p>
        <a className="btn btn-lg" href={f.next ?? f.home}>
          쇼핑 계속하기
        </a>
      </div>
    </Shell>
  );
}
