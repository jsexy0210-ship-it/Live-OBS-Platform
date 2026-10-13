"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useConfirm } from "../../admin-ui/ConfirmDialog";
import { api, failMessage } from "../../seller/api";
import { textLength } from "../../seller/format";
import { formatDate } from "../../../lib/client/format";
import { MARKETING_DOC_VERSION } from "../MarketingConsentDoc";

// SH-011 구매자 회원가입 4단계(보드 SH-011-1~4): 약관 동의(/signup) → 휴대폰 본인확인(/signup/verify) → 정보 입력(/signup/account) → 가입 완료(/signup/done).
// 단계마다 별도 주소이고, 이 공급자가 가입 상태 전체를 들고 있어 단계를 오가도 입력값이 남는다(layout에 있어 화면 이동으로 사라지지 않음).
// 새로고침해도 남도록 비밀번호를 뺀 입력값은 sessionStorage에도 둔다. 어느 단계 주소로 들어와도 첫 미완료 단계로 보낸다(로그인 상태면 홈으로).
// 서버 호출·실패 문구는 이전 한 화면 구현(SignupForm)과 같다: 실패 문구는 서버 message를 그대로 쓴다(lib/server/buyers/signup.ts BUYER_SIGNUP_MESSAGES, lib/server/identity/messages.ts).

// 아래 「재가입 제한 정보 보관」 글의 버전(서버 REJOIN_RETENTION_CONSENT_VERSION과 같은 값). 글을 바꾸면 함께 바꾼다.
// 동의할 때는 서버가 준 버전이 아니라 화면에 보인 글과 묶인 이 버전을 보낸다(마케팅은 MARKETING_DOC_VERSION).
export const REJOIN_DOC_VERSION = "2026-10-03.v1";
export const MAX_NICKNAME_LENGTH = 20;

export type StepKey = "terms" | "verify" | "account" | "done";
export const STEP_ORDER: StepKey[] = ["terms", "verify", "account", "done"];
export const STEP_LABEL: Record<StepKey, string> = { terms: "약관 동의", verify: "본인확인", account: "정보 입력", done: "완료" };
const STEP_PATH: Record<StepKey, string> = { terms: "", verify: "/verify", account: "/account", done: "/done" };

export type Carrier = "SKT" | "KT" | "LGU" | "SKT_MVNO" | "KT_MVNO" | "LGU_MVNO";
export const CARRIERS: { value: Carrier; label: string }[] = [
  { value: "SKT", label: "SKT" },
  { value: "KT", label: "KT" },
  { value: "LGU", label: "LG U+" },
  { value: "SKT_MVNO", label: "알뜰폰 (SKT망)" },
  { value: "KT_MVNO", label: "알뜰폰 (KT망)" },
  { value: "LGU_MVNO", label: "알뜰폰 (LG U+망)" },
];

export type Notice = { kind: "neg" | "info" | "cau"; text: string };
type Fail = { status: number; error: string; message?: string; body?: Record<string, unknown> };
type SignupBody = { verificationId: string; loginId: string; password: string; broadcastNickname: string };
export type SignupConsentInfo = { termsVersion: string; privacyVersion: string; rejoinRetentionVersion: string; marketingVersion: string; rejoinDays: number | null };

// 재가입 가능 날짜는 구매자 공용 KST 연월일 서식을 쓴다.
const kstDate = (iso: unknown): string | null => {
  if (typeof iso !== "string") return null;
  return formatDate(iso) || null;
};

// 가입 결과를 알 수 없는 응답: 끊김(0)이나 5xx. 503(본인확인 서비스 없음)은 처리 전에 막힌 것이라 상태 화면으로 보낸다.
const unclear = (status: number) => status === 0 || (status >= 500 && status !== 503);
export const digits = (v: string, max: number) => v.replace(/\D/g, "").slice(0, max);

// 생년월일 8자리 + 성별 + 내·외국인 → 서버가 받는 birth7(YYMMDD + 성별 자리). 1900년대 1·2, 2000년대 3·4, 외국인은 5~8.
function toBirth7(birth: string, gender: "M" | "F", foreigner: boolean): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(birth);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2099 || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || date.getTime() > Date.now()) return null;
  const base = (y >= 2000 ? 3 : 1) + (gender === "F" ? 1 : 0) + (foreigner ? 4 : 0);
  return `${m[1].slice(2)}${m[2]}${m[3]}${base}`;
}
export const phoneText = (p: string) => (p.length === 11 ? `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}` : `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`);

type Saved = {
  terms: boolean;
  privacy: boolean;
  age14: boolean;
  marketing: boolean;
  rejoin: boolean;
  idvAgreed: boolean;
  name: string;
  birth: string;
  gender: "M" | "F" | null;
  foreigner: boolean;
  carrier: Carrier | "";
  phone: string;
  loginId: string;
  nickname: string;
  verificationId: string | null;
  sent: { name: string; phone: string } | null;
  verified: { name: string; phone: string } | null;
  next: string | null;
};

export type Flow = ReturnType<typeof useFlowState>;
const Ctx = createContext<Flow | null>(null);
export const useSignup = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("SignupProvider 안에서만 쓸 수 있어요");
  return v;
};

function useFlowState({ slug, shopName, consent, identityReady }: { slug: string; shopName: string; consent: SignupConsentInfo; identityReady: boolean }) {
  const router = useRouter();
  const { confirm: askConfirm } = useConfirm();
  const base = `/api/shop/${encodeURIComponent(slug)}/signup`;
  const home = `/shop/${encodeURIComponent(slug)}`;
  const stepPath = (s: StepKey) => `${home}/signup${STEP_PATH[s]}`;
  const storeKey = `signup:${slug}`;

  const [hydrated, setHydrated] = useState(false);
  // 이 쇼핑몰에 로그인한 구매자인지(본인 정보 조회가 200이면 로그인). 로그인 상태로 가입 주소에 들어오면 홈으로 보낸다.
  const [loggedIn, setLoggedIn] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // 체험 중인 쇼핑몰의 본인확인 한도를 넘어 가입이 막힘(처음부터 다시 해도 같아 상태 화면으로 보여 준다)
  const [blocked, setBlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // 단계를 건너뛰어 들어와 첫 미완료 단계로 돌려보낸 안내(그 단계 화면에 한 번 보인다)
  const [guardNotice, setGuardNotice] = useState<string | null>(null);
  const [focusTo, setFocusTo] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (!focusTo) return;
    document.getElementById(focusTo.id)?.focus();
    setFocusTo(null);
  }, [focusTo]);
  const focus = (id: string) => setFocusTo({ id });
  const showNotice = (n: Notice) => {
    setNotice(n);
    focus("signup-notice");
  };

  // 1단계: 약관
  const [terms, setTerms] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [age14, setAge14] = useState(false);
  const [marketing, setMarketing] = useState(false);
  const [termsTouched, setTermsTouched] = useState(false);
  const [docsOutdated, setDocsOutdated] = useState(false);
  // 2단계: 본인확인
  const [name, setName] = useState("");
  const [birth, setBirth] = useState("");
  const [gender, setGender] = useState<"M" | "F" | null>("M");
  const [foreigner, setForeigner] = useState(false);
  const [carrier, setCarrier] = useState<Carrier | "">("");
  const [phone, setPhone] = useState("");
  const [idvAgreed, setIdvAgreed] = useState(false);
  // 재가입 제한을 켠 쇼핑몰만 받는 「재가입 제한 정보 보관 동의」(선택)
  const [rejoin, setRejoin] = useState(false);
  const [birthError, setBirthError] = useState<string | null>(null);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  // 본인확인 시작 한 번(같은 인적사항)의 멱등 키. 응답이 끊겨 다시 누르면 같은 키로 보내 문자·하루 횟수를 다시 쓰지 않는다.
  const attempt = useRef<{ fp: string; key: string } | null>(null);
  const [sent, setSent] = useState<{ name: string; phone: string } | null>(null);
  const [verified, setVerified] = useState<{ name: string; phone: string } | null>(null);
  // 이미 확인됐다는 응답을 받았지만 확인 결과(서버가 확인한 이름·휴대폰)를 아직 못 불러옴
  const [resultPending, setResultPending] = useState(false);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  // 3단계: 계정(비밀번호는 저장하지 않는다)
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [nickname, setNickname] = useState("");
  const [joinedNickname, setJoinedNickname] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<{ body: SignupBody; nickname: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ loginId?: string; password?: string; nickname?: string; terms?: string }>({});
  const [next, setNext] = useState<string | null>(null);

  const rejoinShown = consent.rejoinDays !== null;
  // 화면에 보이는 동의 글(이 화면 코드에 묶인 글)이 서버의 지금 버전과 다르면 동의를 받지 않고 새로고침을 안내한다
  const needsReload = docsOutdated || consent.marketingVersion !== MARKETING_DOC_VERSION || (rejoinShown && consent.rejoinRetentionVersion !== REJOIN_DOC_VERSION);
  const termsOk = terms && privacy && age14;
  const identityMissing = [
    name.trim() === "" && "이름",
    birth.length !== 8 && "생년월일 8자리",
    carrier === "" && "통신사",
    phone.length < 10 && "휴대폰번호",
    !idvAgreed && "본인확인 이용 약관 동의",
  ].filter((x): x is string => !!x);
  const identityFilled = identityMissing.length === 0;
  const nicknameTooLong = textLength(nickname) > MAX_NICKNAME_LENGTH;
  const passwordMismatch = password2 !== "" && password !== password2;
  const accountReady = loginId.trim() !== "" && password !== "" && password === password2 && nickname.trim() !== "" && !nicknameTooLong;
  const accountMissing = [
    loginId.trim() === "" && "아이디",
    password === "" && "비밀번호",
    password !== "" && password !== password2 && "비밀번호 확인",
    (nickname.trim() === "" || nicknameTooLong) && "방송 닉네임",
  ].filter((x): x is string => !!x);
  const codeStage = verificationId !== null && verified === null;

  // 첫 미완료 단계
  const firstIncomplete = (): StepKey => (!termsOk ? "terms" : verified === null ? "verify" : joinedNickname === null ? "account" : "done");

  // ── 새로고침해도 남는 입력값(비밀번호 제외) ──
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(storeKey);
      if (raw) {
        const s = JSON.parse(raw) as Partial<Saved>;
        // 동의 문서 버전이 바뀌었으면 앞 동의는 다시 받는다(저장된 동의는 지금 글에 대한 것이 아니다)
        setTerms(!!s.terms);
        setPrivacy(!!s.privacy);
        setAge14(!!s.age14);
        setMarketing(!!s.marketing);
        setRejoin(!!s.rejoin);
        setIdvAgreed(!!s.idvAgreed);
        setName(s.name ?? "");
        setBirth(s.birth ?? "");
        setGender(s.gender ?? null);
        setForeigner(!!s.foreigner);
        setCarrier(s.carrier ?? "");
        setPhone(s.phone ?? "");
        setLoginId(s.loginId ?? "");
        setNickname(s.nickname ?? "");
        setVerificationId(s.verificationId ?? null);
        setSent(s.sent ?? null);
        setVerified(s.verified ?? null);
        setNext(s.next ?? null);
      }
      // 들어오기 전 화면(같은 쇼핑몰 안 경로만)
      const n = new URLSearchParams(window.location.search).get("next");
      if (n && n.startsWith(`${home}/`)) setNext(n);
    } catch {
      // 저장소를 못 쓰는 환경(사생활 보호 창 등)이면 이번 방문 안에서만 남는다
    }
    let live = true;
    api(`/api/shop/${encodeURIComponent(slug)}/me/profile`, { authRedirect: false }).then((r) => {
      if (!live) return;
      setLoggedIn(r.ok);
      setHydrated(true);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    const s: Saved = { terms, privacy, age14, marketing, rejoin, idvAgreed, name, birth, gender, foreigner, carrier, phone, loginId, nickname, verificationId, sent, verified, next };
    try {
      sessionStorage.setItem(storeKey, JSON.stringify(s));
    } catch {
      // 저장소를 못 쓰면 건너뛴다
    }
  }, [hydrated, storeKey, terms, privacy, age14, marketing, rejoin, idvAgreed, name, birth, gender, foreigner, carrier, phone, loginId, nickname, verificationId, sent, verified, next]);

  // 동의 정보를 다시 불러와 문서 버전이나 재가입 제한 기간이 바뀌면 앞 동의는 다시 받는다
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setTerms(false);
    setPrivacy(false);
  }, [consent.termsVersion, consent.privacyVersion]);
  useEffect(() => {
    setRejoin(false);
  }, [consent.rejoinDays, consent.rejoinRetentionVersion]);

  const go = (s: StepKey) => {
    setGuardNotice(null);
    router.push(stepPath(s));
  };

  // 처음부터 다시: 입력한 인적사항은 두고 본인확인 요청만 버린다
  const restart = (n: Notice | null) => {
    setVerificationId(null);
    setSent(null);
    setVerified(null);
    setResultPending(false);
    setCode("");
    setCodeError(null);
    setUnconfirmed(null);
    setPassword("");
    setPassword2("");
    setNotice(n);
    focus(n ? "signup-notice" : "idv-name");
    if (!window.location.pathname.endsWith("/verify")) router.push(stepPath("verify"));
  };

  // 여러 단계에서 같은 뜻인 실패(서비스 없음·쇼핑몰 막힘·연결 끊김)
  const commonFail = (r: Fail): boolean => {
    if (r.status === 503) {
      setUnavailable(true);
      return true;
    }
    if (r.error === "trial_limit_exceeded") {
      setBlocked(true);
      focus("shop-state-title");
      return true;
    }
    if (r.status === 0 || r.error === "shop_unavailable" || r.error === "provider_error" || r.error === "daily_limit_exceeded") {
      showNotice({ kind: "neg", text: failMessage(r, "public") });
      return true;
    }
    return false;
  };

  const sendCode = async () => {
    if (!identityFilled || busy || gender === null) return;
    const birth7 = toBirth7(birth, gender, foreigner);
    if (!birth7) {
      setBirthError("생년월일 8자리를 다시 확인해 주세요");
      focus("idv-birth");
      return;
    }
    setBusy(true);
    setNotice(null);
    setBirthError(null);
    const device = window.matchMedia("(min-width: 768px)").matches ? "PC" : "MOBILE";
    const person = { name: name.trim(), phone };
    const agreed = {
      agreedTerms: terms,
      agreedPrivacy: privacy,
      termsVersion: consent.termsVersion,
      privacyVersion: consent.privacyVersion,
      ...(rejoinShown
        ? { agreedRejoinRetention: rejoin, ...(rejoin ? { rejoinRetentionVersion: REJOIN_DOC_VERSION, rejoinRestrictionDaysShown: consent.rejoinDays } : {}) }
        : {}),
      agreedMarketing: marketing,
      ...(marketing ? { marketingVersion: MARKETING_DOC_VERSION } : {}),
    };
    const input = { ...person, birth7, carrier, device, ...agreed };
    const fp = JSON.stringify(input);
    if (attempt.current?.fp !== fp) attempt.current = { fp, key: crypto.randomUUID() };
    const r = await api<{ verificationId: string }>(`${base}/verification`, { method: "POST", body: { ...input, attemptKey: attempt.current.key } });
    setBusy(false);
    // 409 start_in_progress(앞 요청이 아직 문자를 보내는 중)·연결 끊김·일시 오류는 키를 두어 다시 누르면 같은 시도로 이어 간다
    if (r.ok || r.error === "already_verified" || r.error === "expired" || r.error === "failed") attempt.current = null;
    if (r.ok) {
      setVerificationId(r.data.verificationId);
      setSent(person);
      setCode("");
      setCodeError(null);
      setNotice({ kind: "info", text: "인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요" });
      focus("idv-code");
      return;
    }
    if (commonFail(r)) return;
    // 입력한 생년월일로 만 14세 미만이면 안내한다
    if (r.error === "under_age") {
      showNotice({ kind: "neg", text: `${failMessage(r, "public")}. 본인확인 생년월일 기준이에요` });
      return;
    }
    // 화면을 연 뒤 동의 문서가 바뀌었다: 이 화면의 글은 예전 것이라 새 버전 동의를 받지 않고 1단계로 돌려보낸다
    if (r.error === "consent_outdated") {
      setDocsOutdated(true);
      setTerms(false);
      setPrivacy(false);
      setNotice({ kind: "cau", text: "약관이 바뀌었어요. 다시 확인해 주세요" });
      go("terms");
      return;
    }
    // 동의가 빠졌거나 재가입 제한 기간이 바뀌었으면 1단계로 보낸다(기간은 서버 값으로 글에 들어가므로 동의 정보만 새로 받아 다시 동의하게 한다)
    if (r.error === "terms_required" || r.error === "invalid_rejoin_consent" || r.error === "invalid_marketing_consent" || r.error === "rejoin_policy_changed") {
      if (r.error === "rejoin_policy_changed") router.refresh();
      setFieldErrors({ terms: failMessage(r, "public") });
      setNotice({ kind: "neg", text: failMessage(r, "public") });
      go("terms");
      return;
    }
    showNotice({ kind: "neg", text: failMessage(r, "public") });
  };

  const resend = async () => {
    if (!verificationId || busy) return;
    setBusy(true);
    setCodeError(null);
    const r = await api(`${base}/verification/resend`, { method: "POST", body: { verificationId } });
    setBusy(false);
    if (r.ok) {
      setCode("");
      setNotice({ kind: "info", text: "인증번호를 다시 보냈어요" });
      focus("idv-code");
      return;
    }
    if (commonFail(r)) return;
    // 확인 응답을 못 받았지만 서버에서는 이미 확인된 경우: 처음부터 하지 않고 확인 완료로 이어 간다(보낸 값 스냅숏 유지)
    if (r.error === "already_verified") {
      await loadVerified();
      return;
    }
    if (r.error === "resend_too_soon") {
      setNotice({ kind: "info", text: failMessage(r, "public") });
      focus("idv-code");
    } else restart({ kind: "neg", text: failMessage(r, "public") });
  };

  const confirm = async () => {
    if (!verificationId || busy || code.length !== 6) return;
    setBusy(true);
    setCodeError(null);
    const r = await api<{ identity?: { name: string; phone: string } }>(`${base}/verification/confirm`, { method: "POST", body: { verificationId, code } });
    setBusy(false);
    // 본인확인 결과 영역은 공급자가 확인한 이름·휴대폰을 보여 준다(응답에 없으면 보낸 값)
    if (r.ok) return markVerified(r.data.identity);
    if (r.error === "already_verified") return loadVerified();
    if (commonFail(r)) return;
    if (r.error === "wrong_code" || r.error === "code_expired") {
      setNotice(null);
      setCodeError(failMessage(r, "public"));
      focus("idv-code");
    } else restart({ kind: "neg", text: failMessage(r, "public") });
  };

  const markVerified = (identity?: { name: string; phone: string }) => {
    const who = identity ?? sent ?? { name: name.trim(), phone };
    setSent(who);
    setVerified(who);
    setResultPending(false);
    setNotice(null);
    setCode("");
    focus("sg-next");
  };

  // 이미 확인된 본인확인: 확인을 한 번 더 불러 서버가 확인한 결과(identity)를 받는다(이미 확인된 기록은 코드와 관계없이 저장값을 준다).
  // 못 불러오면 입력값을 확정 결과처럼 보이지 않게 다음 단계로 넘어가지 않고 다시 시도하게 한다.
  const loadVerified = async () => {
    if (!verificationId) return;
    setBusy(true);
    const r = await api<{ identity?: { name: string; phone: string } }>(`${base}/verification/confirm`, { method: "POST", body: { verificationId, code } });
    setBusy(false);
    if (r.ok) return markVerified(r.data.identity);
    if (r.status === 503) {
      commonFail(r);
      return;
    }
    setResultPending(true);
    showNotice({ kind: "neg", text: "본인확인 결과를 불러오지 못했어요. 다시 시도해 주세요" });
  };

  const signup = async () => {
    if (!verificationId || !accountReady || busy) return;
    if (!(await askConfirm({ tone: "shop", title: "가입할까요?", body: `${shopName}에 ${nickname.trim()} 닉네임으로 가입해요.`, confirmLabel: "가입하기" }))) return;
    setBusy(true);
    setNotice(null);
    setFieldErrors({});
    const body: SignupBody = { verificationId, loginId: loginId.trim(), password, broadcastNickname: nickname.trim() };
    // 응답에 닉네임이 없을 때 쓸 값: 서버(cleanText)가 저장하는 형태(NFKC 정규화 + 앞뒤 공백 제거)
    const pending = { body, nickname: body.broadcastNickname.normalize("NFKC").trim() };
    const r = await api<{ broadcastNickname?: string }>(base, { method: "POST", body });
    if (r.ok) {
      setBusy(false);
      finish(r.data.broadcastNickname ?? pending.nickname);
      return;
    }
    // 응답이 끊겼거나 5xx(503 서비스 없음 제외): 서버에서는 가입됐을 수 있다. 같은 요청을 한 번 다시 보낸다
    // (가입됐으면 같은 회원으로 201과 세션을 다시 준다).
    if (unclear(r.status)) {
      setUnconfirmed(pending);
      await resubmit(pending);
      setBusy(false);
      return;
    }
    setBusy(false);
    signupFail(r);
  };

  // 가입 실패 처리(처음 요청과 재전송 공통): 칸 오류·안내·처음부터 다시
  const signupFail = (r: Fail) => {
    if (commonFail(r)) return;
    const text = failMessage(r, "public");
    switch (r.error) {
      case "invalid_login_id":
      case "login_id_taken":
        setFieldErrors({ loginId: text });
        focus("acc-id");
        break;
      case "weak_password":
        setFieldErrors({ password: text });
        focus("acc-pw");
        break;
      case "invalid_nickname":
      case "nickname_taken":
        setFieldErrors({ nickname: text });
        focus("acc-nick");
        break;
      case "verification_pending":
        setVerified(null);
        setNotice({ kind: "neg", text });
        go("verify");
        break;
      case "verification_invalid":
      case "too_many_signup_attempts":
        restart({ kind: "neg", text });
        break;
      case "rejoin_restricted": {
        // 「지금은 다시 가입할 수 없어요」 뒤에 다시 가입할 수 있는 날(KST)을 붙인다
        const day = kstDate(r.body?.rejoinAvailableAt);
        showNotice({ kind: "neg", text: day ? `${text}. ${day}부터 다시 가입할 수 있어요` : text });
        break;
      }
      default:
        showNotice({ kind: r.error === "already_member" ? "info" : "neg", text });
    }
  };

  const finish = (joined: string) => {
    setJoinedNickname(joined);
    setUnconfirmed(null);
    setPassword("");
    setPassword2("");
    setNotice(null);
    try {
      sessionStorage.removeItem(storeKey);
    } catch {
      // 저장소를 못 쓰면 건너뛴다
    }
    router.push(stepPath("done"));
  };

  // 201이면 완료. 또 끊기거나 5xx면 결과를 알 수 없어 같은 요청으로 다시 시도하게 한다(기존 계정 로그인으로 판단하지 않는다).
  // 그 밖의 4xx는 처음 요청이 처리되기 전에 끊긴 경우라 잠금을 풀고 처음 가입과 같은 오류 처리로 넘긴다.
  const resubmit = async (pending: { body: SignupBody; nickname: string }) => {
    const r = await api<{ broadcastNickname?: string }>(base, { method: "POST", body: pending.body });
    setBusy(false);
    if (r.ok) finish(r.data.broadcastNickname ?? pending.nickname);
    else if (unclear(r.status)) showNotice({ kind: "neg", text: "가입이 끝났는지 확인하지 못했어요. 다시 시도해 주세요" });
    else {
      setUnconfirmed(null);
      signupFail(r);
    }
  };

  const retry = async () => {
    if (!unconfirmed || busy) return;
    setBusy(true);
    await resubmit(unconfirmed);
    setBusy(false);
  };

  return {
    slug,
    shopName,
    consent,
    home,
    stepPath,
    go,
    hydrated,
    loggedIn,
    identityReady,
    unavailable,
    blocked,
    busy,
    notice,
    setNotice,
    guardNotice,
    setGuardNotice,
    focus,
    firstIncomplete,
    // 1단계
    terms, setTerms, privacy, setPrivacy, age14, setAge14, marketing, setMarketing, termsTouched, setTermsTouched, needsReload, termsOk, rejoinShown, fieldErrors, setFieldErrors,
    // 2단계
    name, setName, birth, setBirth, gender, setGender, foreigner, setForeigner, carrier, setCarrier, phone, setPhone, idvAgreed, setIdvAgreed, rejoin, setRejoin,
    birthError, setBirthError, identityMissing, identityFilled, verificationId, sent, verified, resultPending, code, setCode, codeError, setCodeError, codeStage,
    sendCode, resend, confirm, restart, loadVerified,
    // 3단계
    loginId, setLoginId, password, setPassword, password2, setPassword2, nickname, setNickname, nicknameTooLong, passwordMismatch, accountReady, accountMissing, unconfirmed, signup, retry,
    // 4단계
    joinedNickname, next,
  };
}

export function SignupProvider({ slug, shopName, consent, identityReady, children }: { slug: string; shopName: string; consent: SignupConsentInfo; identityReady: boolean; children: React.ReactNode }) {
  const value = useFlowState({ slug, shopName, consent, identityReady });
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// 단계 주소로 들어오면 첫 미완료 단계로 보낸다(앞 단계 없이 바로 들어옴 · 로그인 상태면 홈으로). 가입을 막 끝낸 완료 화면은 그대로 둔다.
export function useStepGuard(step: StepKey): boolean {
  const f = useSignup();
  const router = useRouter();
  const pathname = usePathname();
  const { hydrated, loggedIn, joinedNickname, home, stepPath, firstIncomplete, setGuardNotice } = f;
  const first = firstIncomplete();
  const redirect = hydrated && (loggedIn || STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf(first));
  useEffect(() => {
    if (!hydrated) return;
    if (loggedIn && !(step === "done" && joinedNickname !== null)) {
      router.replace(home);
      return;
    }
    if (STEP_ORDER.indexOf(step) > STEP_ORDER.indexOf(first)) {
      setGuardNotice(`앞 단계부터 진행해 주세요. ${first === "terms" ? "약관 동의" : first === "verify" ? "휴대폰 본인확인" : "정보 입력"}로 돌아가요`);
      router.replace(stepPath(first));
    }
  }, [hydrated, loggedIn, step, first, joinedNickname, home, stepPath, setGuardNotice, router, pathname]);
  return !hydrated || redirect;
}
