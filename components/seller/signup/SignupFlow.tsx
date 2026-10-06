"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmProvider } from "../../admin-ui";
import { kstToday } from "../IdentityCheck";
import { AuthFrame, IdentityUnavailable } from "../PartnersAuth";

// PF-007 파트너스 가입 신청 단계 화면(1 약관 동의 · 2 본인확인 · 3 가입 정보 · 4 사업자 정보 · 5 신청 완료).
// 단계마다 주소가 있고(/seller/signup · /verify · /account · /business · /done), 이 틀(layout)이 단계 사이에서 입력값을 들고 있다.
// 새로고침해도 입력값이 남도록 탭 안(sessionStorage)에 저장한다. 비밀번호는 저장하지 않는다(새로고침하면 다시 적는다).
// 앞 단계를 건너뛰고 주소로 바로 들어오면 첫 미완료 단계로 보낸다. 신청을 마친 뒤에는 완료 화면만 보인다(docs/BACK_ROUTES.md PF-007).
export const SIGNUP_PATHS = ["/seller/signup", "/seller/signup/verify", "/seller/signup/account", "/seller/signup/business", "/seller/signup/done"] as const;
export const SIGNUP_STEPS = ["약관 동의", "본인확인", "가입 정보", "사업자 정보", "신청 완료"];
export type ConsentVersions = { termsVersion: string; privacyVersion: string };
export type Field = "companyName" | "businessNumber" | "openedOn" | "mailOrderNumber" | "email" | "password" | "shopName" | "slug";
export type Fields = Record<Field, string>;
export type Done = { approved: boolean; reviewReasons: string[] };
export type Verification = { id: string; who: { name: string; phone: string } };

export const MIN_PASSWORD_LENGTH = 8; // 서버(lib/server/auth/passwordReset.ts)와 같은 값
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/; // 서버(lib/server/sellers/application.ts)와 같은 규칙
const STORE = "onq-partners-signup-v1";
const EMPTY: Fields = { companyName: "", businessNumber: "", openedOn: "", mailOrderNumber: "", email: "", password: "", shopName: "", slug: "" };

export const digits = (v: string, max: number) => v.replace(/\D/g, "").slice(0, max);
export const bizText = (d: string) => (d.length <= 3 ? d : d.length <= 5 ? `${d.slice(0, 3)}-${d.slice(3)}` : `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`);
const validDate = (d: string) => {
  if (!/^\d{8}$/.test(d)) return false;
  const [y, m, day] = [Number(d.slice(0, 4)), Number(d.slice(4, 6)), Number(d.slice(6))];
  const dt = new Date(Date.UTC(y, m - 1, day));
  // 미래 날짜는 한국 달력 기준으로 거른다(오늘은 된다)
  return y >= 1900 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day && d <= kstToday();
};

// 서버와 같은 규칙으로 먼저 거른다. 단계마다 자기 칸만 본다
export function checkAccount(f: Fields): Partial<Record<Field, string>> {
  const e: Partial<Record<Field, string>> = {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email.trim())) e.email = "이메일 주소를 다시 확인해 주세요";
  if (f.password.length < MIN_PASSWORD_LENGTH) e.password = `${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`;
  if (!f.shopName.trim()) e.shopName = "쇼핑몰 이름을 적어 주세요";
  if (!SLUG.test(f.slug)) e.slug = "영문 소문자 · 숫자 · 하이픈(-)으로 3~30자를 써 주세요";
  return e;
}
export function checkBusiness(f: Fields): Partial<Record<Field, string>> {
  const e: Partial<Record<Field, string>> = {};
  if (!f.companyName.trim()) e.companyName = "상호를 적어 주세요";
  if (f.businessNumber.length !== 10) e.businessNumber = "10자리를 모두 적어 주세요";
  if (!validDate(f.openedOn)) e.openedOn = "개업일 8자리를 다시 확인해 주세요";
  if (!f.mailOrderNumber.trim()) e.mailOrderNumber = "통신판매업 신고번호를 적어 주세요";
  return e;
}

type Notice = { text: string; login?: boolean };
type Flow = {
  versions: ConsentVersions;
  setVersions: (v: ConsentVersions) => void;
  agreedTerms: boolean;
  agreedPrivacy: boolean;
  setAgreed: (terms: boolean, privacy: boolean) => void;
  consentError: string | null;
  setConsentError: (t: string | null) => void;
  verification: Verification | null;
  setVerification: (v: Verification | null) => void;
  f: Fields;
  set: (k: Field, v: string) => void;
  errors: Partial<Record<Field, string>>;
  setErrors: (e: Partial<Record<Field, string>>) => void;
  done: Done | null;
  setDone: (d: Done | null) => void;
  notice: Notice | null;
  setNotice: (n: Notice | null) => void;
  unavailable: boolean;
  setUnavailable: (b: boolean) => void;
  hydrated: boolean;
  // 첫 미완료 단계(0~4). 신청을 마쳤으면 4
  firstOpen: () => number;
};
const Ctx = createContext<Flow | null>(null);
export function useSignup(): Flow {
  const v = useContext(Ctx);
  if (!v) throw new Error("SignupFlow 안에서만 써요");
  return v;
}

type Saved = { agreedTerms?: boolean; agreedPrivacy?: boolean; verification?: Verification | null; f?: Partial<Fields>; done?: Done | null };

export function SignupFlow({ consentVersions, children }: { consentVersions: ConsentVersions; children: React.ReactNode }) {
  return (
    // 로그인 전 화면이라 셸이 없으므로 확인 창 공급자를 이 틀에서 감싼다
    <ConfirmProvider>
      <FlowInner consentVersions={consentVersions}>{children}</FlowInner>
    </ConfirmProvider>
  );
}

function FlowInner({ consentVersions, children }: { consentVersions: ConsentVersions; children: React.ReactNode }) {
  // 보내는 약관 버전: 서버 화면이 넘긴 값. 409 consent_outdated 본문에 지금 버전이 오면 그 값으로 바꾼다
  const [versions, setVersions] = useState(consentVersions);
  useEffect(() => setVersions(consentVersions), [consentVersions]);
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedPrivacy, setAgreedPrivacy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [f, setF] = useState<Fields>(EMPTY);
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [done, setDone] = useState<Done | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // 처음 한 번 저장해 둔 값을 읽는다(서버 화면과 같은 첫 그림을 위해 마운트 뒤에 읽는다)
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORE);
      if (raw) {
        const s = JSON.parse(raw) as Saved;
        setAgreedTerms(!!s.agreedTerms);
        setAgreedPrivacy(!!s.agreedPrivacy);
        if (s.verification?.id) setVerification(s.verification);
        if (s.f) setF({ ...EMPTY, ...s.f, password: "" });
        if (s.done) setDone(s.done);
      }
    } catch {
      // 저장소를 못 읽어도 화면은 그대로 쓴다
    }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      const { password: _omit, ...rest } = f;
      void _omit;
      const s: Saved = { agreedTerms, agreedPrivacy, verification, f: rest, done };
      sessionStorage.setItem(STORE, JSON.stringify(s));
    } catch {
      // 저장하지 못해도 이어서 쓸 수 있다(새로고침하면 처음부터)
    }
  }, [hydrated, agreedTerms, agreedPrivacy, verification, f, done]);

  const set = useCallback((k: Field, v: string) => {
    setF((p) => ({ ...p, [k]: v }));
    setErrors((p) => ({ ...p, [k]: undefined }));
  }, []);
  const setAgreed = useCallback((t: boolean, p: boolean) => {
    setAgreedTerms(t);
    setAgreedPrivacy(p);
  }, []);
  const fRef = useRef(f);
  fRef.current = f;
  const firstOpen = useCallback(() => {
    if (done) return 4;
    if (!agreedTerms || !agreedPrivacy) return 0;
    if (!verification) return 1;
    if (Object.keys(checkAccount(fRef.current)).length > 0) return 2;
    return 3;
  }, [done, agreedTerms, agreedPrivacy, verification]);

  const value = useMemo<Flow>(
    () => ({ versions, setVersions, agreedTerms, agreedPrivacy, setAgreed, consentError, setConsentError, verification, setVerification, f, set, errors, setErrors, done, setDone, notice, setNotice, unavailable, setUnavailable, hydrated, firstOpen }),
    [versions, agreedTerms, agreedPrivacy, setAgreed, consentError, verification, f, set, errors, done, notice, unavailable, hydrated, firstOpen],
  );
  return (
    <Ctx.Provider value={value}>
      <SignupFrame>{children}</SignupFrame>
    </Ctx.Provider>
  );
}

// 지금 주소가 몇 번째 단계인지
export function stepOf(pathname: string): number {
  const i = SIGNUP_PATHS.findIndex((p) => p === pathname.replace(/\/$/, ""));
  return i < 0 ? 0 : i;
}

// 단계 화면이 쓴다: 저장한 값을 읽은 뒤 앞 단계가 비어 있으면 첫 미완료 단계로 보낸다(들어온 기록은 남기지 않는다)
export function useStepGuard(step: number): boolean {
  const { hydrated, firstOpen, done, setNotice } = useSignup();
  const router = useRouter();
  const open = hydrated ? firstOpen() : -1;
  const target = done ? 4 : open;
  const blocked = hydrated && (done ? step !== 4 : step > open);
  useEffect(() => {
    if (!blocked) return;
    if (!done) setNotice({ text: "앞 단계부터 진행해 주세요" });
    router.replace(SIGNUP_PATHS[target]);
  }, [blocked, done, target, router, setNotice]);
  return hydrated && !blocked;
}

function SignupFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { notice, unavailable, done } = useSignup();
  const step = stepOf(pathname);
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);
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
          <div className="row between" style={{ gap: 8 }}>
            <span className="t-l1 fw6 num" data-testid="signup-step-count">
              {step + 1} / {SIGNUP_STEPS.length}
            </span>
          </div>
          <ol className="pa-steps" aria-label="진행 단계">
            {SIGNUP_STEPS.map((s, i) => (
              <li key={s} className={i <= step || (done && i < 4) ? "on" : ""} aria-current={i === step ? "step" : undefined}>
                <span className="pa-step-n">{i + 1}</span>
                <span className={i === step ? "fw7" : "c-alt"}>{s}</span>
              </li>
            ))}
          </ol>
          {notice && (
            <div id="pa-notice" ref={noticeRef} tabIndex={-1} className="msg msg-neg" role="alert" style={{ display: "block" }}>
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
          {children}
        </>
      )}
    </AuthFrame>
  );
}
