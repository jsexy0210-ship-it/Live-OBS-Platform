"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useConfirm } from "../../admin-ui";
import { useSmartBack } from "../../../lib/client/navigation";
import IdentityCheck, { IdentityDone } from "../IdentityCheck";
import { api, failMessage } from "../api";
import { RETRY_TEXT_PUBLIC, stepOutcome } from "../stepFailure";
import { MIN_PASSWORD_LENGTH, SIGNUP_PATHS, bizText, checkAccount, checkBusiness, digits, useSignup, useStepGuard, type Done, type Field } from "./SignupFlow";

// PF-007 단계 화면 본문(틀과 입력값은 SignupFlow). API: POST /api/seller-signup/verification(·/resend·/confirm) → POST /api/seller-signup/apply.
// 필수 동의는 본인확인 시작 요청에 함께 보낸다(문자 비용을 쓰기 전에 서버가 확인). 서버가 terms_required(400)·consent_outdated(409)로
// 거절하면 약관 동의 단계로 돌아가 동의 칸을 비우고 다시 동의하게 한다.
const BASE = "/api/seller-signup/verification";
const CONSENT_TEXT: Record<string, string> = {
  terms_required: "필수 약관에 동의해 주세요",
  consent_outdated: "약관이 바뀌었어요. 다시 확인해 주세요",
};
// 승인 대기 사유(자동 점검에서 걸린 항목)
const REVIEW_TEXT: Record<string, string> = {
  business_lookup_failed: "국세청 조회가 아직 안 끝났어요. 잠시 뒤 확인해요",
  business_info_mismatch: "입력한 사업자 정보가 국세청 기록과 달라요. 사업자등록증을 보고 다시 확인해 주세요",
  business_not_active: "국세청에 영업 중인 사업자로 나오지 않아요",
  business_duplicate: "같은 사업자번호로 운영하거나 신청 중인 쇼핑몰이 있어요",
  mail_order_number_invalid: "통신판매업 신고번호를 확인하지 못했어요",
  mail_order_lookup_failed: "통신판매업 신고 조회를 아직 하지 못했어요",
  mail_order_not_registered: "통신판매업 신고 내역을 찾지 못했어요",
  mail_order_not_active: "통신판매업이 정상 영업 상태가 아니에요",
};

const focusId = (id: string) => setTimeout(() => document.getElementById(id)?.focus(), 0);

function Wait() {
  return <div className="st" style={{ boxShadow: "none", padding: "24px 0" }} aria-busy="true"><span className="spin" /></div>;
}

// ── 1 약관 동의 ──────────────────────────────────────────────
export function TermsStep() {
  const ok = useStepGuard(0);
  const { agreedTerms, agreedPrivacy, setAgreed, consentError, setConsentError, setNotice } = useSignup();
  const router = useRouter();
  const ready = agreedTerms && agreedPrivacy;
  useEffect(() => {
    if (consentError) focusId("su-terms-all");
  }, [consentError]);
  if (!ok) return <Wait />;
  const next = () => {
    if (!ready) {
      setConsentError("필수 약관에 동의해 주세요");
      return focusId("su-terms-all");
    }
    setNotice(null);
    router.push(SIGNUP_PATHS[1]);
  };
  return (
    <div className="col pa-sec">
      {/* 약관 원문(PF-008·PF-009)이 정해지면 「보기」를 붙인다 */}
      <fieldset className="col pa-fs pa-terms" aria-describedby={consentError ? "su-terms-err" : undefined}>
        <legend className="t-hl2">약관 동의</legend>
        <label className="chk pa-terms-all">
          <input
            id="su-terms-all"
            type="checkbox"
            className="cbx"
            checked={ready}
            aria-invalid={!!consentError}
            onChange={(e) => {
              setAgreed(e.target.checked, e.target.checked);
              setConsentError(null);
            }}
          />
          필수 약관에 모두 동의해요
        </label>
        <label className="chk">
          <input type="checkbox" className="cbx" checked={agreedTerms} onChange={(e) => { setAgreed(e.target.checked, agreedPrivacy); setConsentError(null); }} />
          파트너스 이용약관 (필수)
        </label>
        <label className="chk">
          <input type="checkbox" className="cbx" checked={agreedPrivacy} onChange={(e) => { setAgreed(agreedTerms, e.target.checked); setConsentError(null); }} />
          개인정보 수집 · 이용 (필수)
        </label>
        {consentError && (
          <span id="su-terms-err" className="err" role="alert">
            {consentError}
          </span>
        )}
      </fieldset>
      <span className="help">만 19세 이상 사업자만 신청할 수 있어요 · 다음 단계는 대표자 휴대폰 본인확인이에요</span>
      <div className="row between wrap" style={{ gap: 8, paddingTop: 4 }}>
        <Link className="btn btn-lg btn-out" href="/seller/login">
          취소
        </Link>
        <button className="btn btn-lg" type="button" onClick={next}>
          다음
        </button>
      </div>
    </div>
  );
}

// ── 2 본인확인 ───────────────────────────────────────────────
export function VerifyStep() {
  const ok = useStepGuard(1);
  const { versions, setVersions, agreedTerms, agreedPrivacy, setAgreed, setConsentError, verification, setVerification, setNotice, setUnavailable } = useSignup();
  const router = useRouter();
  const back = useSmartBack(SIGNUP_PATHS[0]);
  const [again, setAgain] = useState(0); // 본인확인을 처음부터 다시 할 때 칸을 비우려고 바꾸는 값
  if (!ok) return <Wait />;

  // 서버가 동의를 받지 않았으면 약관 동의 단계로 돌려 보낸다
  const consentRefused = (r: { error: string; body?: Record<string, unknown> }) => {
    const text = CONSENT_TEXT[r.error];
    if (!text) return false;
    setAgreed(false, false);
    setConsentError(text);
    // 약관이 바뀌었으면 지금 버전으로 바꾼다: 서버가 본문에 준 버전을 바로 쓰고, 화면 데이터도 새로 받는다
    if (r.error === "consent_outdated") {
      const { termsVersion, privacyVersion } = r.body ?? {};
      if (typeof termsVersion === "string" && typeof privacyVersion === "string") setVersions({ termsVersion, privacyVersion });
      router.refresh();
    }
    router.replace(SIGNUP_PATHS[0]);
    return true;
  };

  return (
    <div className="col pa-sec">
      {verification ? (
        <IdentityDone tone="public" who={verification.who} onAgain={() => { setVerification(null); setAgain((k) => k + 1); }} />
      ) : (
        <IdentityCheck
          key={again}
          tone="public"
          saveKey="onq-partners-signup-identity-v1"
          label="대표자 휴대폰 본인확인"
          base={BASE}
          blocked={!(agreedTerms && agreedPrivacy)}
          scope={JSON.stringify(versions)}
          start={(person, attemptKey) => api<{ verificationId: string }>(BASE, { method: "POST", body: { ...person, attemptKey, agreedTerms, agreedPrivacy, ...versions } })}
          onStartRefused={consentRefused}
          onUnavailable={() => setUnavailable(true)}
          onVerified={(id, who) => {
            setVerification({ id, who });
            setNotice(null);
          }}
        />
      )}
      <div className="row between wrap" style={{ gap: 8, paddingTop: 4 }}>
        <button className="btn btn-lg btn-out" type="button" onClick={back}>
          이전 단계
        </button>
        <button className="btn btn-lg" type="button" disabled={!verification} onClick={() => { setNotice(null); router.push(SIGNUP_PATHS[2]); }}>
          다음
        </button>
      </div>
    </div>
  );
}

function useFields() {
  const { f, set, errors } = useSignup();
  const err = (k: Field) =>
    errors[k] ? (
      <span id={`su-${k}-err`} className="err" role="alert">
        {errors[k]}
      </span>
    ) : null;
  const inputProps = (k: Field) => ({
    id: `su-${k}`,
    className: `inp${errors[k] ? " is-error" : ""}`,
    value: f[k],
    "aria-invalid": !!errors[k],
    "aria-describedby": errors[k] ? `su-${k}-err` : undefined,
  });
  return { f, set, err, inputProps };
}

// ── 3 가입 정보 ──────────────────────────────────────────────
export function AccountStep() {
  const ok = useStepGuard(2);
  const { setErrors, setNotice, errors } = useSignup();
  const { f, set, err, inputProps } = useFields();
  const router = useRouter();
  const back = useSmartBack(SIGNUP_PATHS[1]);
  // 신청이 서버에서 되돌아와 이 단계의 칸에 오류가 있으면 그 칸으로
  useEffect(() => {
    const first = (["email", "password", "shopName", "slug"] as Field[]).find((k) => errors[k]);
    if (first) focusId(`su-${first}`);
  }, [errors]);
  if (!ok) return <Wait />;
  const next = (ev: React.FormEvent) => {
    ev.preventDefault();
    const e = checkAccount(f);
    if (Object.keys(e).length > 0) {
      setErrors(e);
      return focusId(`su-${Object.keys(e)[0]}`);
    }
    setNotice(null);
    router.push(SIGNUP_PATHS[3]);
  };
  return (
    <form className="col pa-sec" aria-label="가입 정보" onSubmit={next} noValidate>
      <fieldset className="col pa-fs">
        <h2 className="t-hl2">가입 정보</h2>
        <div className="pa-two">
          <div className="fld">
            <label htmlFor="su-email" className="req">
              이메일 (로그인에 써요)
            </label>
            <input {...inputProps("email")} type="email" autoComplete="username" maxLength={200} onChange={(e) => set("email", e.target.value)} />
            {err("email")}
          </div>
          <div className="fld">
            <label htmlFor="su-password" className="req">
              비밀번호
            </label>
            <input {...inputProps("password")} type="password" autoComplete="new-password" maxLength={200} onChange={(e) => set("password", e.target.value)} />
            {err("password") ?? <span className="help">{MIN_PASSWORD_LENGTH}자 이상</span>}
          </div>
          <div className="fld">
            <label htmlFor="su-shopName" className="req">
              쇼핑몰 이름
            </label>
            <input {...inputProps("shopName")} maxLength={50} onChange={(e) => set("shopName", e.target.value)} />
            {err("shopName") ?? <span className="help">나중에 바꿀 수 있어요</span>}
          </div>
          <div className="fld">
            <label htmlFor="su-slug" className="req">
              쇼핑몰 주소
            </label>
            <input {...inputProps("slug")} autoCapitalize="none" spellCheck={false} maxLength={30} placeholder="예: byulbit" onChange={(e) => set("slug", e.target.value.toLowerCase())} />
            {err("slug") ?? <span className="help">영문 소문자 · 숫자 · 하이픈(-)으로 3~30자 · 구매자가 쇼핑몰 주소창에 쓰는 이름이에요</span>}
          </div>
        </div>
        <span className="help">입력한 내용은 새로고침하거나 뒤로 가도 남아 있어요(비밀번호는 빼고) · 이전 단계로 돌아가도 그대로예요</span>
        <div className="row between wrap" style={{ gap: 8, paddingTop: 4 }}>
          <button className="btn btn-lg btn-out" type="button" onClick={back}>
            이전 단계
          </button>
          <button className="btn btn-lg" type="submit">
            다음
          </button>
        </div>
      </fieldset>
    </form>
  );
}

// ── 4 사업자 정보 · 신청 ─────────────────────────────────────
export function BusinessStep() {
  const ok = useStepGuard(3);
  const { verification, setVerification, f, setErrors, setNotice, setDone, setConsentError, setAgreed } = useSignup();
  const { set, err, inputProps } = useFields();
  const { confirm } = useConfirm();
  const router = useRouter();
  const back = useSmartBack(SIGNUP_PATHS[2]);
  const [busy, setBusy] = useState(false);
  if (!ok) return <Wait />;

  // 본인확인을 처음부터 다시(입력한 사업자·계정 정보는 그대로 둔다)
  const restartIdentity = (text: string | null) => {
    setVerification(null);
    setNotice(text ? { text } : null);
    router.replace(SIGNUP_PATHS[1]);
  };

  const apply = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!verification || busy) return;
    const e = { ...checkAccount(f), ...checkBusiness(f) };
    if (Object.keys(e).length > 0) {
      setErrors(e);
      const first = Object.keys(e)[0] as Field;
      if (["email", "password", "shopName", "slug"].includes(first)) {
        setNotice({ text: first === "password" ? "비밀번호를 다시 적어 주세요" : "빨간 글씨가 있는 칸을 다시 확인해 주세요" });
        return router.replace(SIGNUP_PATHS[2]);
      }
      return focusId(`su-${first}`);
    }
    const sure = await confirm({
      tone: "shop",
      title: "입력한 내용으로 가입을 신청할까요?",
      body: `상호 ${f.companyName.trim()}, 쇼핑몰 주소 ${f.slug}로 신청해요. 신청한 뒤에는 쇼핑몰 주소를 바꿀 수 없어요.`,
      confirmLabel: "신청하기",
    });
    if (!sure) return;
    setBusy(true);
    setNotice(null);
    const r = await api<Done>("/api/seller-signup/apply", {
      method: "POST",
      body: {
        verificationId: verification.id,
        companyName: f.companyName.trim(),
        businessNumber: f.businessNumber,
        openedOn: f.openedOn,
        mailOrderNumber: f.mailOrderNumber.trim(),
        email: f.email.trim(),
        password: f.password,
        shopName: f.shopName.trim(),
        slug: f.slug,
      },
    });
    setBusy(false);
    if (r.ok) {
      // 신청을 마쳤으면 본인확인 기록·입력한 본인 정보는 이 탭에서 지운다
      try {
        sessionStorage.removeItem("onq-partners-signup-identity-v1");
      } catch {
        // 지우지 못해도 신청은 끝났다
      }
      setVerification(null);
      setDone(r.data);
      router.replace(SIGNUP_PATHS[4]);
      return;
    }
    const out = stepOutcome(r);
    if (out === "unavailable") return setNotice({ text: failMessage(r, "public", RETRY_TEXT_PUBLIC) });
    // 본인확인 기록에 필수 동의가 없으면 약관 동의부터 다시
    if (CONSENT_TEXT[r.error]) {
      setVerification(null);
      setAgreed(false, false);
      setConsentError(CONSENT_TEXT[r.error]);
      router.replace(SIGNUP_PATHS[0]);
      return;
    }
    // 서버가 본인확인을 다시 하라고 한 경우만 처음부터. 연결 끊김·서버 오류·확인 중이면 본인확인을 그대로 두고 다시 신청하게 한다
    // (서버는 같은 본인확인·같은 입력의 재신청에 이미 만든 신청 결과를 돌려준다)
    if (out === "restart") return restartIdentity("본인확인 시간이 지났거나 확인되지 않았어요. 본인확인을 다시 해 주세요");
    if (out === "retry" || r.error === "verification_pending") {
      setNotice({ text: r.error === "verification_pending" ? "본인확인 결과를 확인하고 있어요. 잠시 뒤 다시 신청해 주세요" : failMessage(r, "public", RETRY_TEXT_PUBLIC) });
      return;
    }
    const toAccount = (k: Field, text: string) => {
      setErrors({ [k]: text });
      router.replace(SIGNUP_PATHS[2]);
    };
    if (r.error === "weak_password") return toAccount("password", `${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`);
    if (r.error === "invalid_slug") return toAccount("slug", "쓸 수 없는 주소예요. 다른 주소를 정해 주세요");
    if (r.error === "slug_taken") return toAccount("slug", "이미 쓰고 있는 주소예요. 다른 주소를 정해 주세요");
    if (r.error === "invalid_business_number") {
      setErrors({ businessNumber: "사업자등록번호를 다시 확인해 주세요" });
      return focusId("su-businessNumber");
    }
    if (r.error === "representative_has_shop") return setNotice({ text: failMessage(r, "public"), login: true });
    setNotice({ text: r.error === "invalid_input" ? "빨간 글씨가 있는 칸을 다시 확인해 주세요" : failMessage(r, "public", "신청하지 못했어요. 잠시 뒤 다시 시도해 주세요") });
  };

  return (
    <form className="col pa-sec" aria-label="사업자 정보" onSubmit={apply} noValidate>
      <fieldset className="col pa-fs" disabled={busy}>
        <h2 className="t-hl2">사업자 정보</h2>
        <span className="help">사업자등록증을 보고 적어 주세요 · 적은 정보는 국세청 · 통신판매업 신고 내역과 자동으로 맞춰 봐요</span>
        <div className="pa-two">
          <div className="fld">
            <label htmlFor="su-companyName" className="req">
              상호
            </label>
            <input {...inputProps("companyName")} maxLength={100} onChange={(e) => set("companyName", e.target.value)} />
            {err("companyName")}
          </div>
          <div className="fld">
            <label htmlFor="su-businessNumber" className="req">
              사업자등록번호
            </label>
            <input
              {...inputProps("businessNumber")}
              className={`${inputProps("businessNumber").className} num`}
              value={bizText(f.businessNumber)}
              inputMode="numeric"
              placeholder="숫자 10자리"
              onChange={(e) => set("businessNumber", digits(e.target.value, 10))}
            />
            {err("businessNumber")}
          </div>
          <div className="fld">
            <label htmlFor="su-openedOn" className="req">
              개업일
            </label>
            <input {...inputProps("openedOn")} className={`${inputProps("openedOn").className} num`} inputMode="numeric" placeholder="예: 20200101" onChange={(e) => set("openedOn", digits(e.target.value, 8))} />
            {err("openedOn") ?? <span className="help">사업자등록증에 적힌 날짜예요</span>}
          </div>
          <div className="fld">
            <label htmlFor="su-mailOrderNumber" className="req">
              통신판매업 신고번호
            </label>
            <input {...inputProps("mailOrderNumber")} maxLength={100} placeholder="예: 제2024-서울강남-01234호" onChange={(e) => set("mailOrderNumber", e.target.value)} />
            {err("mailOrderNumber") ?? <span className="help">없으면 신고 후 신청해 주세요</span>}
          </div>
        </div>
        <span className="help">입력한 내용은 새로고침하거나 뒤로 가도 남아 있어요(비밀번호는 빼고) · 이전 단계로 돌아가도 그대로예요</span>
        <div className="row between wrap" style={{ gap: 8, paddingTop: 4 }}>
          <button className="btn btn-lg btn-out" type="button" onClick={back}>
            이전 단계
          </button>
          <button className={`btn btn-lg${busy ? " is-loading" : ""}`} type="submit" disabled={!verification || busy}>
            {busy ? "신청하고 있어요" : "신청하기"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

// ── 5 신청 완료 ──────────────────────────────────────────────
export function DoneStep() {
  const ok = useStepGuard(4);
  const { done } = useSignup();
  useEffect(() => {
    if (ok && done) focusId("pa-done-title");
  }, [ok, done]);
  if (!ok || !done) return <Wait />;
  return (
    <div className="col pa-result" style={{ alignItems: "center", textAlign: "center", gap: 14 }}>
      <div className="st-ic pa-result-ic" data-approved={done.approved} aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          {done.approved ? (
            <path d="M5 12l5 5L20 7" />
          ) : (
            <>
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </>
          )}
        </svg>
      </div>
      <h2 className="t-t2" id="pa-done-title" tabIndex={-1}>
        {done.approved ? "가입을 마쳤어요" : "신청을 받았어요"}
      </h2>
      {done.approved ? (
        <p className="t-b2 c-neu">바로 로그인해서 쇼핑몰을 준비할 수 있어요.</p>
      ) : (
        <>
          <p className="t-b2 c-neu">확인이 필요한 항목이 있어 살펴본 뒤 결과를 알려 드려요. 그 전에는 로그인할 수 없어요.</p>
          {done.reviewReasons.length > 0 && (
            <ul className="pa-reasons">
              {done.reviewReasons.map((x) => (
                <li key={x}>{REVIEW_TEXT[x] ?? "확인이 필요한 항목이 있어요"}</li>
              ))}
            </ul>
          )}
        </>
      )}
      <Link className="btn btn-lg" href="/seller/login">
        {done.approved ? "로그인하기" : "로그인 화면으로"}
      </Link>
    </div>
  );
}
