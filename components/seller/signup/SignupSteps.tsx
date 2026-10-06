"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useConfirm } from "../../admin-ui";
import { useSmartBack } from "../../../lib/client/navigation";
import IdentityCheck, { IdentityDone } from "../IdentityCheck";
import { api, failMessage } from "../api";
import { RETRY_TEXT_PUBLIC, stepOutcome } from "../stepFailure";
import { INDUSTRIES, MIN_PASSWORD_LENGTH, NO_AGREE, SIGNUP_PATHS, bizText, checkAccount, checkBusiness, digits, phoneDigits, useSignup, useStepGuard, type Done, type Field } from "./SignupFlow";

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
  const { agree, setAgree, consentError, setConsentError, setNotice } = useSignup();
  const router = useRouter();
  const ready = agree.terms && agree.privacy && agree.policy;
  const all = ready && agree.marketing;
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
  const row = (key: keyof typeof agree, label: string, required: boolean, href?: string) => (
    <label className="row between" style={{ gap: 10 }}>
      <span className="row" style={{ gap: 10 }}>
        <input type="checkbox" className="cbx" checked={agree[key]} onChange={(e) => { setAgree({ [key]: e.target.checked }); setConsentError(null); }} />
        <span className="t-l1">
          {label} <span className={required ? "c-neg" : "c-alt"}>({required ? "필수" : "선택"})</span>
        </span>
      </span>
      {href && (
        <Link className="t-l2" href={href} target="_blank" rel="noopener">
          보기
        </Link>
      )}
    </label>
  );
  return (
    <div className="col pa-sec">
      <fieldset className="col pa-fs pa-terms" aria-describedby={consentError ? "su-terms-err" : undefined}>
        <legend className="t-hl2">약관 동의</legend>
        <label className="chk pa-terms-all">
          <input
            id="su-terms-all"
            type="checkbox"
            className="cbx"
            checked={all}
            aria-invalid={!!consentError}
            onChange={(e) => {
              setAgree({ terms: e.target.checked, privacy: e.target.checked, policy: e.target.checked, marketing: e.target.checked });
              setConsentError(null);
            }}
          />
          모두 동의해요
        </label>
        {row("terms", "이용약관", true, "/terms")}
        {row("privacy", "개인정보 수집 · 이용", true, "/privacy")}
        {row("policy", "파트너스 운영 정책 (구매자 개인정보 보호 · 방송 표시 규칙)", true, "/terms")}
        {row("marketing", "새 기능 · 혜택 소식 받기", false)}
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
  const { versions, setVersions, agree, setAgree, setConsentError, verification, setVerification, setLicense, setNotice, setUnavailable } = useSignup();
  const router = useRouter();
  const back = useSmartBack(SIGNUP_PATHS[0]);
  const [again, setAgain] = useState(0); // 본인확인을 처음부터 다시 할 때 칸을 비우려고 바꾸는 값
  if (!ok) return <Wait />;

  // 서버가 동의를 받지 않았으면 약관 동의 단계로 돌려 보낸다
  const consentRefused = (r: { error: string; body?: Record<string, unknown> }) => {
    const text = CONSENT_TEXT[r.error];
    if (!text) return false;
    setAgree({ terms: false, privacy: false, policy: false });
    setConsentError(text);
    // 약관이 바뀌었으면 지금 버전으로 바꾼다: 서버가 본문에 준 버전을 바로 쓰고, 화면 데이터도 새로 받는다
    if (r.error === "consent_outdated") {
      const { termsVersion, privacyVersion, policyVersion, marketingVersion } = r.body ?? {};
      if (typeof termsVersion === "string" && typeof privacyVersion === "string" && typeof policyVersion === "string" && typeof marketingVersion === "string") {
        setVersions({ termsVersion, privacyVersion, policyVersion, marketingVersion });
      }
      router.refresh();
    }
    router.replace(SIGNUP_PATHS[0]);
    return true;
  };

  return (
    <div className="col pa-sec">
      {verification ? (
        <IdentityDone tone="public" who={verification.who} onAgain={() => { setVerification(null); setLicense(null); setAgain((k) => k + 1); }} />
      ) : (
        <IdentityCheck
          key={again}
          tone="public"
          saveKey="onq-partners-signup-identity-v1"
          label="대표자 휴대폰 본인확인"
          base={BASE}
          blocked={!(agree.terms && agree.privacy && agree.policy)}
          scope={JSON.stringify(versions)}
          start={(person, attemptKey) => api<{ verificationId: string }>(BASE, { method: "POST", body: { ...person, attemptKey, agreedTerms: agree.terms, agreedPrivacy: agree.privacy, agreedPolicy: agree.policy, agreedMarketing: agree.marketing, ...versions } })}
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

// ── 신청(3단계 「신청하기」(방송 화면만 쓰기) · 4단계 「신청하기」) ────────────────────
// 서버 거절을 단계마다 알맞은 칸·단계로 되돌린다. 성공하면 입력한 본인 정보 기록을 지우고 완료 화면으로 간다.
function useApply() {
  const { verification, setVerification, setLicense, f, setErrors, setNotice, setDone, setConsentError, setAgree } = useSignup();
  const { confirm } = useConfirm();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const overlay = f.track === "OVERLAY_ONLY";

  // 본인확인을 처음부터 다시(입력한 사업자·계정 정보는 그대로 둔다)
  const restartIdentity = (text: string | null) => {
    setVerification(null);
    setLicense(null);
    setNotice(text ? { text } : null);
    router.replace(SIGNUP_PATHS[1]);
  };

  const apply = async () => {
    if (!verification || busy) return;
    const e = overlay ? checkAccount(f) : { ...checkAccount(f), ...checkBusiness(f) };
    if (Object.keys(e).length > 0) {
      setErrors(e);
      const first = Object.keys(e)[0] as Field;
      if (["email", "password", "shopName", "slug", "channelUrl"].includes(first)) {
        setNotice({ text: first === "password" ? "비밀번호를 다시 적어 주세요" : "빨간 글씨가 있는 칸을 다시 확인해 주세요" });
        if (window.location.pathname !== SIGNUP_PATHS[2]) router.replace(SIGNUP_PATHS[2]);
        else focusId(`su-${first}`);
        return;
      }
      return focusId(`su-${first}`);
    }
    const sure = await confirm({
      tone: "shop",
      title: "입력한 내용으로 가입을 신청할까요?",
      body: overlay
        ? `방송 화면만 쓰기로, 쇼핑몰 주소 ${f.slug}로 신청해요. 신청한 뒤에는 쇼핑몰 주소를 바꿀 수 없어요.`
        : `상호 ${f.companyName.trim()}, 쇼핑몰 주소 ${f.slug}로 신청해요. 신청한 뒤에는 쇼핑몰 주소를 바꿀 수 없어요.`,
      confirmLabel: "신청하기",
    });
    if (!sure) return;
    setBusy(true);
    setNotice(null);
    const r = await api<Done>("/api/seller-signup/apply", {
      method: "POST",
      body: {
        verificationId: verification.id,
        planCode: f.track,
        email: f.email.trim(),
        password: f.password,
        shopName: f.shopName.trim(),
        slug: f.slug,
        industry: f.industry,
        channelUrl: f.channelUrl.trim(),
        ...(overlay
          ? {}
          : {
              companyName: f.companyName.trim(),
              businessNumber: f.businessNumber,
              openedOn: f.openedOn,
              mailOrderNumber: f.mailOrderNumber.trim(),
              contactPhone: phoneDigits(f.contactPhone),
              businessAddress: [f.zip.trim(), f.address.trim(), f.addressDetail.trim()].filter(Boolean).join(" "),
            }),
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
      setLicense(null);
      setDone(r.data);
      router.replace(SIGNUP_PATHS[4]);
      return;
    }
    const out = stepOutcome(r);
    if (out === "unavailable") return setNotice({ text: failMessage(r, "public", RETRY_TEXT_PUBLIC) });
    // 본인확인 기록에 필수 동의가 없으면 약관 동의부터 다시
    if (CONSENT_TEXT[r.error]) {
      setVerification(null);
      setLicense(null);
      setAgree({ terms: false, privacy: false, policy: false });
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
  return { apply, busy, overlay };
}

// ── 3 가입 정보 ──────────────────────────────────────────────
type SlugState = { slug: string; state: "ok" | "taken" | "invalid" | "busy" | "none" };
export function AccountStep() {
  const ok = useStepGuard(2);
  const { setErrors, setNotice, errors } = useSignup();
  const { f, set, err, inputProps } = useFields();
  const { apply, busy, overlay } = useApply();
  const router = useRouter();
  const back = useSmartBack(SIGNUP_PATHS[1]);
  const [slugCheck, setSlugCheck] = useState<SlugState | null>(null);
  // 신청이 서버에서 되돌아와 이 단계의 칸에 오류가 있으면 그 칸으로
  useEffect(() => {
    const first = (["email", "password", "shopName", "slug", "channelUrl"] as Field[]).find((k) => errors[k]);
    if (first) focusId(`su-${first}`);
  }, [errors]);
  // 쇼핑몰 주소가 규칙에 맞으면 잠깐 뒤 사용할 수 있는지 서버에 묻는다(타자를 멈추면)
  useEffect(() => {
    const slug = f.slug;
    if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(slug)) return setSlugCheck(null);
    setSlugCheck({ slug, state: "busy" });
    let live = true;
    const t = setTimeout(async () => {
      const r = await api<{ available: boolean; reason: "invalid" | "taken" | null }>(`/api/seller-signup/slug-check?slug=${encodeURIComponent(slug)}`);
      if (!live) return;
      // 확인하지 못하면(연결 끊김·너무 잦은 확인) 표시하지 않는다. 신청할 때 서버가 다시 확인한다
      if (!r.ok) return setSlugCheck(null);
      setSlugCheck({ slug, state: r.data.available ? "ok" : r.data.reason === "taken" ? "taken" : "invalid" });
    }, 500);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [f.slug]);
  if (!ok) return <Wait />;
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const e = checkAccount(f);
    if (Object.keys(e).length > 0) {
      setErrors(e);
      return focusId(`su-${Object.keys(e)[0]}`);
    }
    if (slugCheck?.slug === f.slug && (slugCheck.state === "taken" || slugCheck.state === "invalid")) {
      setErrors({ slug: slugCheck.state === "taken" ? "이미 쓰고 있는 주소예요. 다른 주소를 정해 주세요" : "쓸 수 없는 주소예요. 다른 주소를 정해 주세요" });
      return focusId("su-slug");
    }
    setNotice(null);
    if (overlay) return void apply();
    router.push(SIGNUP_PATHS[3]);
  };
  const slugHelp =
    slugCheck?.slug === f.slug && slugCheck.state === "ok" ? (
      <span className="help" style={{ color: "var(--pos-text)" }}>
        쓸 수 있는 주소예요 · onq.kr/{f.slug}
      </span>
    ) : slugCheck?.slug === f.slug && slugCheck.state !== "busy" && slugCheck.state !== "none" ? (
      <span className="err" role="alert">
        {slugCheck.state === "taken" ? "이미 쓰고 있는 주소예요. 다른 주소를 정해 주세요" : "쓸 수 없는 주소예요. 다른 주소를 정해 주세요"}
      </span>
    ) : (
      <span className="help">영문 소문자 · 숫자 · 하이픈(-)으로 3~30자 · 구매자가 쇼핑몰 주소창에 쓰는 이름이에요</span>
    );
  return (
    <form className="col pa-sec" aria-label="가입 정보" onSubmit={submit} noValidate>
      <fieldset className="col pa-fs" disabled={busy}>
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
            {err("slug") ?? slugHelp}
          </div>
          <div className="fld">
            <label htmlFor="su-industry" className="req">
              주로 파는 것
            </label>
            <select id="su-industry" className="inp" value={f.industry} onChange={(e) => set("industry", e.target.value)}>
              {INDUSTRIES.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="su-channelUrl">방송 채널 주소 (선택)</label>
            <input {...inputProps("channelUrl")} type="url" inputMode="url" autoCapitalize="none" spellCheck={false} maxLength={200} placeholder="유튜브 · 치지직 등 채널 주소" onChange={(e) => set("channelUrl", e.target.value)} />
            {err("channelUrl") ?? <span className="help">심사에 참고해요. 없어도 신청할 수 있어요.</span>}
          </div>
        </div>
        <fieldset className="col" style={{ gap: 8, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <legend className="t-hl2" style={{ padding: 0, marginBottom: 8 }}>
            지금 운영 중인 쇼핑몰이 있나요?
          </legend>
          <div className="pa-two">
            {(
              [
                ["OVERLAY_ONLY", "있어요 · 방송 화면만 쓸게요", "지금 쇼핑몰은 그대로 두고 방송 주문대기와 방송 화면만 붙여요", "오버레이 전용 · 7일 체험 · 사업자 정보 없이 바로 신청"],
                ["INTEGRATED", "없어요 · 쇼핑몰까지 쓸게요", "ONQ 쇼핑몰을 열고 상품 · 주문 · 배송까지 한곳에서 운영해요", "쇼핑몰 통합 · 다음 단계에서 사업자 정보를 받아요"],
              ] as const
            ).map(([value, title, line1, line2]) => (
              <label
                key={value}
                className="col"
                style={{
                  gap: 6,
                  padding: 14,
                  borderRadius: 12,
                  boxShadow: f.track === value ? "inset 0 0 0 2px var(--brand)" : "inset 0 0 0 1px var(--wds-line-normal-normal)",
                  background: f.track === value ? "var(--wds-background-status-positive)" : undefined,
                }}
              >
                <span className="row" style={{ gap: 8 }}>
                  <input className="rdo" type="radio" name="su-track" checked={f.track === value} onChange={() => set("track", value)} />
                  <span className="t-l1 fw7">{title}</span>
                </span>
                <span className="t-c1 c-neu">{line1}</span>
                <span className="t-c1 c-alt">{line2}</span>
              </label>
            ))}
          </div>
          <span className="t-c1 c-alt">나중에 로그인한 뒤 「시작하기」에서 바꿀 수 있어요</span>
        </fieldset>
        {overlay && <span className="t-c1 c-alt">사업자 정보 단계를 건너뛰고 바로 신청해요 · 진행 표시는 4단계가 「건너뜀」으로 보여요</span>}
        <span className="help">입력한 내용은 새로고침하거나 뒤로 가도 남아 있어요(비밀번호는 빼고) · 이전 단계로 돌아가도 그대로예요</span>
        <div className="row between wrap" style={{ gap: 8, paddingTop: 4 }}>
          <button className="btn btn-lg btn-out" type="button" onClick={back}>
            이전 단계
          </button>
          <button className={`btn btn-lg${busy ? " is-loading" : ""}`} type="submit" disabled={busy}>
            {busy ? "신청하고 있어요" : overlay ? "신청하기" : "다음"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

// ── 4 사업자 정보 · 신청 ─────────────────────────────────────
type BizCheck = {
  business: { lookup: boolean; valid: boolean | null; status: string | null };
  duplicate: boolean;
  mailOrder: { state: "NORMAL" | "NOT_REGISTERED" | "NOT_ACTIVE" | "LOOKUP_FAILED" | "INVALID_NUMBER" } | null;
};
const LICENSE_MAX = 10 * 1024 * 1024;

// 사업장 주소 검색: 무료 우편번호 서비스(다음 우편번호, 키 없음)의 검색 창. 스크립트는 4단계에서만 불러온다(MASTER 결정 2026-10-06).
// 불러오지 못하거나 검색 창을 열지 못하면 우편번호 · 기본 주소 칸이 바로 입력칸으로 바뀐다(정본 PF-007-4 「주소 검색을 열지 못함 · 직접 입력」).
const POSTCODE_SRC = "https://t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
type PostcodeData = { zonecode: string; roadAddress: string; jibunAddress: string; userSelectedType: "R" | "J"; buildingName?: string; apartment?: "Y" | "N" };
type DaumGlobal = { Postcode: new (o: { oncomplete: (d: PostcodeData) => void }) => { open: () => void } };
function usePostcode(enabled: boolean) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  useEffect(() => {
    if (!enabled) return;
    const w = window as unknown as { daum?: DaumGlobal };
    if (w.daum?.Postcode) return setState("ready");
    setState("loading");
    const tag = document.createElement("script");
    tag.src = POSTCODE_SRC;
    tag.async = true;
    // 15초 안에 못 불러오면 직접 입력으로 바꾼다
    const timer = setTimeout(() => setState((p) => (p === "loading" ? "failed" : p)), 15_000);
    tag.onload = () => {
      clearTimeout(timer);
      setState((window as unknown as { daum?: DaumGlobal }).daum?.Postcode ? "ready" : "failed");
    };
    tag.onerror = () => {
      clearTimeout(timer);
      setState("failed");
    };
    document.head.appendChild(tag);
    return () => {
      clearTimeout(timer);
      tag.onload = null;
      tag.onerror = null;
    };
  }, [enabled]);
  const open = (onPick: (d: PostcodeData) => void) => {
    const w = window as unknown as { daum?: DaumGlobal };
    try {
      if (!w.daum?.Postcode) throw new Error("postcode_missing");
      new w.daum.Postcode({ oncomplete: onPick }).open();
    } catch {
      setState("failed");
    }
  };
  return { state, open };
}
const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export function BusinessStep() {
  const ok = useStepGuard(3);
  const { verification, license, setLicense, f, setErrors, setNotice } = useSignup();
  const { set, err, inputProps } = useFields();
  const { apply, busy, overlay } = useApply();
  const back = useSmartBack(SIGNUP_PATHS[2]);
  const [check, setCheck] = useState<BizCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const postcode = usePostcode(f.track !== "OVERLAY_ONLY");
  if (!ok) return <Wait />;

  // 방송 화면만 쓰기: 이 단계가 없다. 3단계에서 바로 신청한다
  if (overlay) {
    return (
      <div className="col pa-sec">
        <div className="msg msg-info" style={{ display: "block" }}>
          <b>오버레이 전용은 사업자 정보가 필요 없어요.</b> 3단계에서 바로 신청하고, 사업자 · 정산 정보는 쇼핑몰 통합으로 바꿀 때 받아요.
        </div>
        <div className="row between" style={{ padding: "10px 12px", borderRadius: 10, background: "var(--wds-fill-alternative)" }}>
          <span className="t-l2 c-alt">사업자 정보</span>
          <span className="bdg b-gray">건너뜀</span>
        </div>
        <div className="row between wrap" style={{ gap: 8, paddingTop: 4 }}>
          <button className="btn btn-lg btn-out" type="button" onClick={back}>
            이전 단계
          </button>
          <button className={`btn btn-lg${busy ? " is-loading" : ""}`} type="button" disabled={!verification || busy} onClick={() => void apply()}>
            {busy ? "신청하고 있어요" : "신청하기"}
          </button>
        </div>
      </div>
    );
  }

  // 「조회」: 국세청·통신판매업을 미리 맞춰 본다(결과는 신청을 막지 않는다. 신청할 때 서버가 다시 점검한다)
  const lookup = async () => {
    if (!verification || checking) return;
    const e: Partial<Record<Field, string>> = {};
    if (f.businessNumber.length !== 10) e.businessNumber = "10자리를 모두 적어 주세요";
    if (!/^\d{8}$/.test(f.openedOn)) e.openedOn = "개업일 8자리를 다시 확인해 주세요";
    if (Object.keys(e).length > 0) {
      setErrors(e);
      return focusId(`su-${Object.keys(e)[0]}`);
    }
    setChecking(true);
    setCheckNote(null);
    const r = await api<BizCheck>("/api/seller-signup/business-check", {
      method: "POST",
      body: { verificationId: verification.id, businessNumber: f.businessNumber, openedOn: f.openedOn, mailOrderNumber: f.mailOrderNumber.trim() },
    });
    setChecking(false);
    if (r.ok) return setCheck(r.data);
    setCheck(null);
    if (r.error === "invalid_business_number") setErrors({ businessNumber: "사업자등록번호를 다시 확인해 주세요" });
    else if (r.error === "invalid_opened_on") setErrors({ openedOn: "개업일 8자리를 다시 확인해 주세요" });
    else if (r.error === "limit_exceeded") setCheckNote("조회를 너무 많이 했어요. 신청은 그대로 할 수 있어요");
    else if (r.error === "verification_invalid") setNotice({ text: "본인확인 시간이 지났어요. 이전 단계에서 본인확인을 다시 해 주세요" });
    else setCheckNote(failMessage(r, "public", "조회하지 못했어요. 잠시 뒤 다시 시도해 주세요"));
  };

  // 사업자등록증 올리기: 서버가 형식(JPG·PNG·PDF)·크기(10MB)를 다시 확인한다
  const upload = async (file: File | undefined) => {
    if (!file || !verification) return;
    setUploadError(null);
    if (file.size > LICENSE_MAX) return setUploadError("10MB 이하 파일만 올릴 수 있어요");
    setUploading(true);
    let res: Response | null = null;
    try {
      res = await fetch(`/api/seller-signup/business-license?verificationId=${encodeURIComponent(verification.id)}`, { method: "PUT", headers: { "x-file-name": encodeURIComponent(file.name) }, body: file, cache: "no-store" });
    } catch {
      res = null;
    }
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
    const body = res ? ((await res.json().catch(() => ({}))) as { license?: { fileName: string; byteSize: number }; message?: string; error?: string }) : {};
    if (res?.ok && body.license) return setLicense({ fileName: body.license.fileName, byteSize: body.license.byteSize });
    if (body.error === "verification_invalid") return setNotice({ text: "본인확인 시간이 지났어요. 이전 단계에서 본인확인을 다시 해 주세요" });
    setUploadError(body.message ?? "올리지 못했어요. 잠시 뒤 다시 시도해 주세요");
  };

  const openedYear = f.openedOn.slice(0, 4);
  const bizResult = check
    ? !check.business.lookup
      ? { tone: "cau", text: "국세청 조회가 아직 안 끝났어요. 잠시 뒤 확인해요" }
      : check.business.valid === false
        ? { tone: "neg", text: "입력한 사업자 정보가 국세청 기록과 달라요. 사업자등록증을 보고 다시 확인해 주세요" }
        : check.business.status !== "ACTIVE"
          ? { tone: "cau", title: "국세청에 영업 중인 사업자로 나오지 않아요", text: "영업 중인 사업자만 신청할 수 있어요. 잘못 나온 것 같으면 문의해 주세요." }
          : null
    : null;
  const bizOk = check?.business.lookup && check.business.valid !== false && check.business.status === "ACTIVE";
  const mailResult = check?.mailOrder
    ? {
        NORMAL: null,
        NOT_REGISTERED: { tone: "neg", text: "통신판매업 신고 내역을 찾지 못했어요" },
        NOT_ACTIVE: { tone: "cau", text: "통신판매업이 정상 영업 상태가 아니에요" },
        LOOKUP_FAILED: { tone: "info", text: "통신판매업 신고 조회를 아직 하지 못했어요 · 신청은 받고 확인이 끝나면 알려 드려요" },
        INVALID_NUMBER: { tone: "neg", text: "통신판매업 신고번호를 확인하지 못했어요" },
      }[check.mailOrder.state]
    : null;

  return (
    <form className="col pa-sec" aria-label="사업자 정보" onSubmit={(ev) => { ev.preventDefault(); void apply(); }} noValidate>
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
            <div className="row" style={{ gap: 6 }}>
              <input
                {...inputProps("businessNumber")}
                className={`${inputProps("businessNumber").className} num`}
                style={{ flex: 1 }}
                value={bizText(f.businessNumber)}
                inputMode="numeric"
                placeholder="숫자 10자리"
                onChange={(e) => {
                  set("businessNumber", digits(e.target.value, 10));
                  setCheck(null);
                }}
              />
              <button className={`btn btn-out${checking ? " is-loading" : ""}`} type="button" disabled={checking || !verification} onClick={() => void lookup()}>
                {checking ? "조회하고 있어요" : "조회"}
              </button>
            </div>
            {err("businessNumber") ??
              (bizOk ? (
                <span className="help" style={{ color: "var(--pos-text)" }}>
                  계속사업자{/^\d{4}$/.test(openedYear) ? ` · ${openedYear}년 개업` : ""}
                </span>
              ) : null)}
          </div>
          <div className="fld">
            <label htmlFor="su-openedOn" className="req">
              개업일
            </label>
            <input {...inputProps("openedOn")} className={`${inputProps("openedOn").className} num`} inputMode="numeric" placeholder="예: 20200101" onChange={(e) => { set("openedOn", digits(e.target.value, 8)); setCheck(null); }} />
            {err("openedOn") ?? <span className="help">사업자등록증에 적힌 날짜예요</span>}
          </div>
          <div className="fld">
            <label htmlFor="su-mailOrderNumber" className="req">
              통신판매업 신고번호
            </label>
            <input {...inputProps("mailOrderNumber")} maxLength={100} placeholder="예: 제2024-서울강남-01234호" onChange={(e) => { set("mailOrderNumber", e.target.value); setCheck(null); }} />
            {err("mailOrderNumber") ?? <span className="help">없으면 신고 후 신청해 주세요</span>}
          </div>
          <div className="fld">
            <label htmlFor="su-contactPhone" className="req">
              연락처
            </label>
            <input {...inputProps("contactPhone")} type="tel" inputMode="tel" autoComplete="tel" maxLength={20} onChange={(e) => set("contactPhone", e.target.value)} />
            {err("contactPhone")}
          </div>
          <div className="fld" style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="su-address" className="req">
              사업장 주소
            </label>
            {postcode.state === "failed" && (
              <div className="msg msg-cau" role="status" style={{ display: "block", width: "100%" }}>
                주소 검색을 열지 못했어요. 우편번호와 주소를 직접 적어 주세요
              </div>
            )}
            <div className="row" style={{ gap: 8 }}>
              <input
                id="su-zip"
                className="inp num"
                style={{ width: 120, ...(postcode.state === "failed" ? {} : { background: "var(--wds-fill-alternative)" }) }}
                inputMode="numeric"
                maxLength={5}
                value={f.zip}
                readOnly={postcode.state !== "failed"}
                aria-label="우편번호"
                placeholder="우편번호"
                onChange={(e) => set("zip", digits(e.target.value, 5))}
              />
              <button
                id="su-address-search"
                className="btn btn-out"
                type="button"
                style={{ flex: "none" }}
                disabled={postcode.state !== "ready"}
                onClick={() =>
                  postcode.open((d) => {
                    const base = d.userSelectedType === "R" ? d.roadAddress : d.jibunAddress;
                    const extra = d.userSelectedType === "R" && d.apartment === "Y" && d.buildingName ? ` (${d.buildingName})` : "";
                    set("zip", digits(d.zonecode, 5));
                    set("address", `${base}${extra}`.slice(0, 150));
                    focusId("su-addressDetail");
                  })
                }
              >
                주소 검색
              </button>
            </div>
            <input
              {...inputProps("address")}
              style={postcode.state === "failed" ? undefined : { background: "var(--wds-fill-alternative)" }}
              readOnly={postcode.state !== "failed"}
              maxLength={150}
              aria-label="기본 주소"
              placeholder="기본 주소"
              onChange={(e) => set("address", e.target.value)}
            />
            <input id="su-addressDetail" className="inp" maxLength={50} value={f.addressDetail} aria-label="상세 주소" placeholder="상세 주소" onChange={(e) => set("addressDetail", e.target.value)} />
            {err("address") ??
              (postcode.state === "failed" ? (
                <span className="help">우편번호 서비스 스크립트를 못 불러오면 우편번호 · 기본 주소 칸이 바로 입력칸으로 바뀌어요 · 다시 시도는 새로고침</span>
              ) : (
                <span className="help">사업자등록증의 주소와 같아야 해요 · 「주소 검색」은 무료 우편번호 서비스예요 · 검색 창이 열리지 않으면 우편번호 · 주소를 직접 적을 수 있어요</span>
              ))}
          </div>
        </div>
        {bizResult && (
          <div className={`msg msg-${bizResult.tone}`} role="status" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
            {"title" in bizResult && bizResult.title && <b>{bizResult.title}</b>}
            <span>{bizResult.text}</span>
          </div>
        )}
        {mailResult && (
          <div className={`msg msg-${mailResult.tone}`} role="status" style={{ display: "block" }}>
            {mailResult.text}
          </div>
        )}
        {check?.duplicate && (
          <div className="msg msg-cau" role="status" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
            <span>
              <b>같은 사업자번호로 운영하거나 신청 중인 쇼핑몰이 있어요.</b> 한 사업자는 쇼핑몰 하나만 열 수 있어요.
            </span>
            <span className="row" style={{ gap: 8 }}>
              <Link className="btn btn-sm" href="/seller/login">
                로그인하기
              </Link>
              <Link className="btn btn-sm btn-out" href="/faq" target="_blank" rel="noopener">
                문의하기
              </Link>
            </span>
          </div>
        )}
        {checkNote && (
          <div className="msg msg-info" role="status" style={{ display: "block" }}>
            {checkNote}
          </div>
        )}
        <div className="col" style={{ gap: 6 }}>
          <span className="lbl">
            사업자등록증 <span className="c-alt">(선택)</span>
          </span>
          <div className="row" style={{ gap: 12, alignItems: "center", padding: 14, borderRadius: 10, border: "2px dashed var(--wds-line-normal-normal)" }}>
            <span className="col" style={{ gap: 2, flex: 1 }}>
              <span className="t-l1 fw6">{license ? `${license.fileName} · ${sizeText(license.byteSize)}` : "올린 파일이 없어요"}</span>
              <span className="t-c1 c-alt">글자가 또렷하게 보이는 사진이면 돼요 · JPG · PNG · PDF · 지금 안 올리면 심사 때 요청할 수 있어요</span>
            </span>
            <input ref={fileRef} id="su-license" type="file" accept="image/jpeg,image/png,application/pdf,.jpg,.jpeg,.png,.pdf" hidden onChange={(e) => void upload(e.target.files?.[0])} />
            <button className={`btn btn-sm btn-out${uploading ? " is-loading" : ""}`} type="button" disabled={uploading || !verification} onClick={() => fileRef.current?.click()}>
              {uploading ? "올리고 있어요" : license ? "바꾸기" : "올리기"}
            </button>
          </div>
          {uploadError && (
            <span className="err" role="alert">
              {uploadError}
            </span>
          )}
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
  if (done.approved) {
    return (
      <div className="col pa-result" style={{ gap: 10, padding: 18, borderRadius: 12, background: "var(--wds-background-status-positive)", textAlign: "center", alignItems: "center" }}>
        <h2 className="t-t3" id="pa-done-title" tabIndex={-1}>
          가입을 마쳤어요
        </h2>
        <span className="t-b1 c-neu">바로 로그인해서 쇼핑몰을 준비할 수 있어요.</span>
        <Link className="btn btn-lg" href="/seller/login">
          로그인하기
        </Link>
      </div>
    );
  }
  return (
    <div className="col pa-result" style={{ alignItems: "center", textAlign: "center", gap: 18 }}>
      <div className="st-ic pa-result-ic" data-approved={false} aria-hidden>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12l5 5L20 7" />
        </svg>
      </div>
      <h2 className="t-t2" id="pa-done-title" tabIndex={-1}>
        신청을 받았어요
      </h2>
      <p className="t-b1 c-neu" style={{ lineHeight: 1.7 }}>
        대표자 본인 확인과 사업자 정보를 바로 확인해요 · 보통 몇 분 안에 결과를 알려 드려요.
        <br />
        확인이 필요하면 2영업일 안에 알려 드려요.
        <br />
        승인되면 이메일과 알림톡으로 파트너스 관리자 주소를 보내 드려요.
        <br />
        보완이 필요하면 메일로 먼저 연락드릴게요.
      </p>
      {done.reviewReasons.length > 0 && (
        <div className="msg msg-info" style={{ display: "block", width: "100%", textAlign: "left" }}>
          <b>확인이 필요한 항목이 있어요.</b> 살펴본 뒤 결과를 알려 드려요. 그 전에는 로그인할 수 없어요.
          <ul className="pa-reasons">
            {done.reviewReasons.map((x) => (
              <li key={x}>{REVIEW_TEXT[x] ?? "확인이 필요한 항목이 있어요"}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="col" style={{ padding: 18, gap: 8, width: "100%", background: "var(--page)", textAlign: "left", borderRadius: 12 }}>
        <span className="t-hl2">승인되면 이렇게 시작해요</span>
        {[
          "메일로 받은 관리자 주소에서 가입 때 정한 비밀번호로 로그인해요",
          "「시작하기」 단계를 따라 준비해요 · 방송 화면만 쓰기는 승인일부터 7일이 체험 기간이에요",
          "이용권 결제 → 쇼핑몰 정보 → 상품 등록 → 주문 규칙 → 방송 화면 꾸미기 → 방송 화면 주소 복사 순서예요",
        ].map((t, i) => (
          <span key={t} className="row t-l1" style={{ gap: 8 }}>
            <span className="num fw7 c-pri">{i + 1}</span>
            <span className="c-neu">{t}</span>
          </span>
        ))}
      </div>
      <div className="row wrap" style={{ gap: 8, justifyContent: "center" }}>
        <Link className="btn btn-lg" href="/seller/pending">
          신청 상태 보기
        </Link>
        <Link className="btn btn-lg btn-out" href="/features">
          기능 미리 보기
        </Link>
      </div>
    </div>
  );
}
