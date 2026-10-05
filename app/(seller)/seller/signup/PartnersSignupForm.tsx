"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import IdentityCheck, { IdentityDone, kstToday } from "../../../../components/seller/IdentityCheck";
import { AuthFrame, IdentityUnavailable, Steps } from "../../../../components/seller/PartnersAuth";
import { api, failMessage } from "../../../../components/seller/api";
import { RETRY_TEXT_PUBLIC, stepOutcome } from "../../../../components/seller/stepFailure";

// PF-007 파트너스 가입 신청: 1 필수 약관 동의(PF-007-1) · 대표자 휴대폰 본인확인 → 2 사업자·계정·쇼핑몰 정보 → 3 신청 완료(바로 승인 또는 승인 대기).
// API: POST /api/seller-signup/verification(·/resend·/confirm) → POST /api/seller-signup/apply.
// 필수 동의는 본인확인 시작 요청에 함께 보낸다(문자 비용을 쓰기 전에 서버가 확인). 서버가 terms_required(400)·consent_outdated(409)로
// 거절하면 동의 칸을 비우고 다시 동의하게 한다. 약관 버전은 서버 화면(page.tsx)이 넘기고, consent_outdated면 화면 데이터를 새로 받아
// 바뀐 버전으로 다시 동의하게 한다(배포 전에 열어 둔 화면이 예전 버전을 계속 보내지 않게).
// 본인확인 대행사 연결 전에는 API가 503을 주고, 이 화면은 「본인확인 서비스 준비 중이에요」 상태로 바꾼다.
const STEPS = ["본인확인", "정보 입력", "신청 완료"];
const BASE = "/api/seller-signup/verification";
const MIN_PASSWORD_LENGTH = 8; // 서버(lib/server/auth/passwordReset.ts)와 같은 값
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/; // 서버(lib/server/sellers/application.ts)와 같은 규칙
export type ConsentVersions = { termsVersion: string; privacyVersion: string };
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

type Field = "companyName" | "businessNumber" | "openedOn" | "mailOrderNumber" | "email" | "password" | "shopName" | "slug";
type Done = { approved: boolean; reviewReasons: string[] };

const digits = (v: string, max: number) => v.replace(/\D/g, "").slice(0, max);
const bizText = (d: string) => (d.length <= 3 ? d : d.length <= 5 ? `${d.slice(0, 3)}-${d.slice(3)}` : `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`);
const validDate = (d: string) => {
  if (!/^\d{8}$/.test(d)) return false;
  const [y, m, day] = [Number(d.slice(0, 4)), Number(d.slice(4, 6)), Number(d.slice(6))];
  const dt = new Date(Date.UTC(y, m - 1, day));
  // 미래 날짜는 한국 달력 기준으로 거른다(오늘은 된다)
  return y >= 1900 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day && d <= kstToday();
};

export default function PartnersSignupForm({ consentVersions }: { consentVersions: ConsentVersions }) {
  const router = useRouter();
  // 보내는 약관 버전: 서버 화면이 넘긴 값. 409 consent_outdated 본문에 지금 버전이 오면 그 값으로 바꾼다
  const [versions, setVersions] = useState(consentVersions);
  useEffect(() => setVersions(consentVersions), [consentVersions]);
  const [step, setStep] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  const [verification, setVerification] = useState<{ id: string; who: { name: string; phone: string } } | null>(null);
  // 본인확인을 처음부터 다시 할 때 칸을 비우려고 바꾸는 값
  const [idvKey, setIdvKey] = useState(0);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedPrivacy, setAgreedPrivacy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  // 인증번호를 보낸 동안에는 동의 칸을 잠근다(보낸 동의와 화면이 어긋나지 않게)
  const [idvSent, setIdvSent] = useState(false);
  const consentReady = agreedTerms && agreedPrivacy;
  const [notice, setNotice] = useState<{ text: string; login?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  const [f, setF] = useState({ companyName: "", businessNumber: "", openedOn: "", mailOrderNumber: "", email: "", password: "", shopName: "", slug: "" });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [focusTo, setFocusTo] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (!focusTo) return;
    document.getElementById(focusTo.id)?.focus();
    setFocusTo(null);
  }, [focusTo]);
  const focus = (id: string) => setFocusTo({ id });

  const set = (k: Field, v: string) => {
    setF((p) => ({ ...p, [k]: v }));
    setErrors((p) => ({ ...p, [k]: undefined }));
  };

  const toUnavailable = () => {
    setUnavailable(true);
    focus("pa-state-title");
  };

  // 본인확인을 처음부터 다시(입력한 사업자·계정 정보는 그대로 둔다)
  const restartIdentity = (text: string | null) => {
    setVerification(null);
    setIdvKey((k) => k + 1);
    setStep(0);
    setNotice(text ? { text } : null);
    focus(text ? "pa-notice" : "idv-name");
  };

  // 서버가 동의를 받지 않았으면(terms_required·consent_outdated) 동의 칸을 비우고 그 칸에서 안내한다
  const consentRefused = (r: { error: string; body?: Record<string, unknown> }) => {
    const text = CONSENT_TEXT[r.error];
    if (!text) return false;
    setAgreedTerms(false);
    setAgreedPrivacy(false);
    setConsentError(text);
    // 시작 요청이 끝났으므로 동의 칸을 바로 풀어 포커스를 옮길 수 있게 한다(IdentityCheck가 알리는 것보다 먼저)
    setIdvSent(false);
    // 약관이 바뀌었으면 지금 버전으로 바꾼다: 서버가 본문에 준 버전을 바로 쓰고, 화면 데이터도 새로 받는다(입력한 칸은 그대로 둔다)
    if (r.error === "consent_outdated") {
      const { termsVersion, privacyVersion } = r.body ?? {};
      if (typeof termsVersion === "string" && typeof privacyVersion === "string") setVersions({ termsVersion, privacyVersion });
      router.refresh();
    }
    focus("su-terms-all");
    return true;
  };

  // 서버와 같은 규칙으로 먼저 걸러 칸 아래에 알려 준다
  const check = (): Partial<Record<Field, string>> => {
    const e: Partial<Record<Field, string>> = {};
    if (!f.companyName.trim()) e.companyName = "상호를 적어 주세요";
    if (f.businessNumber.length !== 10) e.businessNumber = "10자리를 모두 적어 주세요";
    if (!validDate(f.openedOn)) e.openedOn = "개업일 8자리를 다시 확인해 주세요";
    if (!f.mailOrderNumber.trim()) e.mailOrderNumber = "통신판매업 신고번호를 적어 주세요";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) e.email = "이메일 주소를 다시 확인해 주세요";
    if (f.password.length < MIN_PASSWORD_LENGTH) e.password = `${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`;
    if (!f.shopName.trim()) e.shopName = "쇼핑몰 이름을 적어 주세요";
    if (!SLUG.test(f.slug)) e.slug = "영문 소문자 · 숫자 · 하이픈(-)으로 3~30자를 써 주세요";
    return e;
  };

  const apply = async (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!verification || busy) return;
    const e = check();
    if (Object.keys(e).length > 0) {
      setErrors(e);
      focus(`su-${Object.keys(e)[0]}`);
      return;
    }
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
      setDone(r.data);
      setStep(2);
      focus("pa-done-title");
      return;
    }
    const out = stepOutcome(r);
    if (out === "unavailable") return toUnavailable();
    // 본인확인 기록에 필수 동의가 없으면 약관 동의부터 다시
    if (CONSENT_TEXT[r.error]) {
      restartIdentity(null);
      consentRefused(r);
      return;
    }
    // 서버가 본인확인을 다시 하라고 한 경우만 처음부터. 연결 끊김·서버 오류·확인 중이면 본인확인을 그대로 두고 다시 신청하게 한다
    // (서버는 같은 본인확인·같은 입력의 재신청에 이미 만든 신청 결과를 돌려준다)
    if (out === "restart") return restartIdentity("본인확인 시간이 지났거나 확인되지 않았어요. 본인확인을 다시 해 주세요");
    if (out === "retry" || r.error === "verification_pending") {
      setNotice({ text: r.error === "verification_pending" ? "본인확인 결과를 확인하고 있어요. 잠시 뒤 다시 신청해 주세요" : failMessage(r, "public", RETRY_TEXT_PUBLIC) });
      return focus("pa-notice");
    }
    const field = (k: Field, text: string) => {
      setErrors({ [k]: text });
      focus(`su-${k}`);
    };
    if (r.error === "weak_password") return field("password", `${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`);
    if (r.error === "invalid_slug") return field("slug", "쓸 수 없는 주소예요. 다른 주소를 정해 주세요");
    if (r.error === "slug_taken") return field("slug", "이미 쓰고 있는 주소예요. 다른 주소를 정해 주세요");
    if (r.error === "invalid_business_number") return field("businessNumber", "사업자등록번호를 다시 확인해 주세요");
    if (r.error === "representative_has_shop") {
      setNotice({ text: failMessage(r, "public"), login: true });
      return focus("pa-notice");
    }
    setNotice({ text: r.error === "invalid_input" ? "빨간 글씨가 있는 칸을 다시 확인해 주세요" : failMessage(r, "public", "신청하지 못했어요. 잠시 뒤 다시 시도해 주세요") });
    focus("pa-notice");
  };

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

  return (
    <AuthFrame wide>
      <div className="col" style={{ gap: 4 }}>
        <h1 className="t-t3">파트너스 가입 신청</h1>
        <span className="t-l2 c-alt">대표자 본인 확인을 하고 사업자 정보를 적으면 바로 확인해요.</span>
      </div>
      {unavailable ? (
        <IdentityUnavailable action="가입을 신청할" tone="public" />
      ) : (
        <>
          <Steps steps={STEPS} current={step} />
          {notice && (
            <div id="pa-notice" tabIndex={-1} className="msg msg-neg" role="alert" style={{ display: "block" }}>
              <span>{notice.text}</span>
              {notice.login && (
                <span className="row" style={{ gap: 6, marginTop: 8 }}>
                  <Link className="btn btn-sm" href="/seller/login">
                    로그인하기
                  </Link>
                </span>
              )}
            </div>
          )}
          {step === 2 && done ? (
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
          ) : (
            <>
              {verification ? (
                <IdentityDone tone="public" who={verification.who} disabled={busy} onAgain={() => restartIdentity(null)} />
              ) : (
                <>
                  {/* 필수 동의는 본인확인을 요청하기 전에 받는다(PF-007-1). 약관 원문(PF-008·PF-009)이 정해지면 「보기」를 붙인다 */}
                  <fieldset className="col pa-fs pa-terms" disabled={idvSent} aria-describedby={consentError ? "su-terms-err" : undefined}>
                    <legend className="t-hl2">약관 동의</legend>
                    <label className="chk pa-terms-all">
                      <input
                        id="su-terms-all"
                        type="checkbox"
                        className="cbx"
                        checked={consentReady}
                        aria-invalid={!!consentError}
                        onChange={(e) => {
                          setAgreedTerms(e.target.checked);
                          setAgreedPrivacy(e.target.checked);
                          setConsentError(null);
                        }}
                      />
                      필수 약관에 모두 동의해요
                    </label>
                    <label className="chk">
                      <input type="checkbox" className="cbx" checked={agreedTerms} onChange={(e) => { setAgreedTerms(e.target.checked); setConsentError(null); }} />
                      파트너스 이용약관 (필수)
                    </label>
                    <label className="chk">
                      <input type="checkbox" className="cbx" checked={agreedPrivacy} onChange={(e) => { setAgreedPrivacy(e.target.checked); setConsentError(null); }} />
                      개인정보 수집 · 이용 (필수)
                    </label>
                    {consentError && (
                      <span id="su-terms-err" className="err" role="alert">
                        {consentError}
                      </span>
                    )}
                  </fieldset>
                  <IdentityCheck
                    key={idvKey}
                    tone="public"
                    label="대표자 휴대폰 본인확인"
                    base={BASE}
                    blocked={!consentReady}
                    scope={JSON.stringify(versions)}
                    start={(person, attemptKey) =>
                      api<{ verificationId: string }>(BASE, { method: "POST", body: { ...person, attemptKey, agreedTerms, agreedPrivacy, ...versions } })
                    }
                    onStartRefused={consentRefused}
                    onSentChange={setIdvSent}
                    onUnavailable={toUnavailable}
                    onVerified={(id, who) => {
                      setVerification({ id, who });
                      setNotice(null);
                      setStep(1);
                      focus("su-companyName");
                    }}
                  />
                </>
              )}
              <form className="col pa-sec" aria-label="가입 정보" onSubmit={apply} noValidate>
                <fieldset className={`col pa-fs${verification ? "" : " is-waiting"}`} disabled={!verification || busy}>
                  <h2 className="t-hl2">사업자 정보</h2>
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
                      <input
                        {...inputProps("openedOn")}
                        className={`${inputProps("openedOn").className} num`}
                        inputMode="numeric"
                        placeholder="예: 20200101"
                        onChange={(e) => set("openedOn", digits(e.target.value, 8))}
                      />
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
                  <h2 className="t-hl2" style={{ marginTop: 8 }}>
                    계정 · 쇼핑몰
                  </h2>
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
                      <input
                        {...inputProps("slug")}
                        autoCapitalize="none"
                        spellCheck={false}
                        maxLength={30}
                        placeholder="예: byulbit"
                        onChange={(e) => set("slug", e.target.value.toLowerCase())}
                      />
                      {err("slug") ?? <span className="help">영문 소문자·숫자·하이픈(-)으로 3~30자. 구매자가 쇼핑몰 주소창에 쓰는 이름이에요</span>}
                    </div>
                  </div>
                  <div className="row between wrap" style={{ gap: 8, paddingTop: 4 }}>
                    <Link className="btn btn-lg btn-out" href="/seller/login">
                      취소
                    </Link>
                    <button className={`btn btn-lg${busy ? " is-loading" : ""}`} type="submit" disabled={!verification || busy}>
                      {busy ? "신청하고 있어요" : "신청하기"}
                    </button>
                  </div>
                </fieldset>
              </form>
            </>
          )}
        </>
      )}
    </AuthFrame>
  );
}
