"use client";

import { useState } from "react";
import { api, failMessage } from "../seller/api";
import { textLength } from "../seller/format";
import ShopState from "./ShopState";

// SH-011 구매자 회원가입: 휴대폰 본인확인(인증번호 받기 → 확인) → 아이디·비밀번호·방송 닉네임·필수 약관 → 가입.
// 실패 문구는 서버 message를 그대로 쓴다(정본: lib/server/buyers/signup.ts BUYER_SIGNUP_MESSAGES, lib/server/identity/messages.ts).
type Carrier = "SKT" | "KT" | "LGU" | "SKT_MVNO" | "KT_MVNO" | "LGU_MVNO";
const CARRIERS: { value: Carrier; label: string }[] = [
  { value: "SKT", label: "SKT" },
  { value: "KT", label: "KT" },
  { value: "LGU", label: "LG U+" },
  { value: "SKT_MVNO", label: "알뜰폰 (SKT망)" },
  { value: "KT_MVNO", label: "알뜰폰 (KT망)" },
  { value: "LGU_MVNO", label: "알뜰폰 (LG U+망)" },
];

type Step = "identity" | "code" | "verified" | "done";
type Notice = { kind: "neg" | "info"; text: string };
type Fail = { status: number; error: string; message?: string };

// 방송 닉네임 최대 글자 수. 서버(lib/server/buyers/signup.ts MAX_NICKNAME_LENGTH)와 같은 값, 같은 셈법(코드포인트, textLength).
// 입력 칸 maxLength는 UTF-16 단위라 이모지가 절반에서 잘리므로 쓰지 않는다.
const MAX_NICKNAME_LENGTH = 20;

const digits = (v: string, max: number) => v.replace(/\D/g, "").slice(0, max);

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

const phoneText = (p: string) => (p.length === 11 ? `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}` : `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`);

export default function SignupForm({ slug }: { slug: string }) {
  const base = `/api/shop/${encodeURIComponent(slug)}/signup`;
  const [step, setStep] = useState<Step>("identity");
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // 본인확인
  const [name, setName] = useState("");
  const [birth, setBirth] = useState("");
  const [gender, setGender] = useState<"M" | "F" | null>(null);
  const [foreigner, setForeigner] = useState(false);
  const [carrier, setCarrier] = useState<Carrier | "">("");
  const [phone, setPhone] = useState("");
  const [idvAgreed, setIdvAgreed] = useState(false);
  const [birthError, setBirthError] = useState<string | null>(null);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  // 본인확인을 요청한 값(요청 뒤 화면은 이 값을 보여 준다)
  const [sent, setSent] = useState<{ name: string; phone: string } | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);

  // 계정
  const [loginId, setLoginId] = useState("");
  const [password, setPassword] = useState("");
  const [nickname, setNickname] = useState("");
  const [agreedTerms, setAgreedTerms] = useState(false);
  const [agreedPrivacy, setAgreedPrivacy] = useState(false);
  // 가입을 요청한 닉네임(완료 문구는 이 값을 쓴다)
  const [joinedNickname, setJoinedNickname] = useState("");
  const [fieldErrors, setFieldErrors] = useState<{ loginId?: string; password?: string; nickname?: string; terms?: string }>({});

  const identityReady = name.trim() !== "" && birth.length === 8 && gender !== null && carrier !== "" && phone.length >= 10 && idvAgreed;
  const nicknameTooLong = textLength(nickname) > MAX_NICKNAME_LENGTH;
  const accountReady = loginId.trim() !== "" && password !== "" && nickname.trim() !== "" && !nicknameTooLong && agreedTerms && agreedPrivacy;

  // 처음부터 다시: 입력한 인적사항은 두고 본인확인 요청만 버린다
  const restart = (n: Notice | null) => {
    setVerificationId(null);
    setSent(null);
    setCode("");
    setCodeError(null);
    setStep("identity");
    setNotice(n);
  };

  // 여러 단계에서 같은 뜻인 실패(서비스 없음·쇼핑몰 막힘·연결 끊김)
  const commonFail = (r: Fail): boolean => {
    if (r.status === 503) {
      setUnavailable(true);
      return true;
    }
    if (r.status === 0 || r.error === "shop_unavailable" || r.error === "provider_error" || r.error === "daily_limit_exceeded") {
      setNotice({ kind: "neg", text: failMessage(r) });
      return true;
    }
    return false;
  };

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identityReady || busy || gender === null) return;
    const birth7 = toBirth7(birth, gender, foreigner);
    if (!birth7) {
      setBirthError("생년월일 8자리를 다시 확인해 주세요");
      return;
    }
    setBusy(true);
    setNotice(null);
    setBirthError(null);
    const device = window.matchMedia("(min-width: 768px)").matches ? "PC" : "MOBILE";
    const person = { name: name.trim(), phone };
    const r = await api<{ verificationId: string }>(`${base}/verification`, {
      method: "POST",
      body: { ...person, birth7, carrier, device },
    });
    setBusy(false);
    if (r.ok) {
      setVerificationId(r.data.verificationId);
      setSent(person);
      setCode("");
      setCodeError(null);
      setStep("code");
      setNotice({ kind: "info", text: "인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요" });
      return;
    }
    if (!commonFail(r)) setNotice({ kind: "neg", text: failMessage(r) });
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
      return;
    }
    if (commonFail(r)) return;
    // 확인 응답을 못 받았지만 서버에서는 이미 확인된 경우: 처음부터 하지 않고 확인 완료로 이어 간다(보낸 값 스냅숏 유지)
    if (r.error === "already_verified") {
      setStep("verified");
      setNotice(null);
      return;
    }
    if (r.error === "resend_too_soon") setNotice({ kind: "info", text: failMessage(r) });
    else restart({ kind: "neg", text: failMessage(r) });
  };

  const confirm = async () => {
    if (!verificationId || busy || code.length !== 6) return;
    setBusy(true);
    setCodeError(null);
    const r = await api(`${base}/verification/confirm`, { method: "POST", body: { verificationId, code } });
    setBusy(false);
    if (r.ok || (!r.ok && r.error === "already_verified")) {
      setStep("verified");
      setNotice(null);
      return;
    }
    if (commonFail(r)) return;
    if (r.error === "wrong_code" || r.error === "code_expired") {
      setNotice(null);
      setCodeError(failMessage(r));
    } else restart({ kind: "neg", text: failMessage(r) });
  };

  const signup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verificationId || !accountReady || busy) return;
    setBusy(true);
    setNotice(null);
    setFieldErrors({});
    const broadcastNickname = nickname.trim();
    const r = await api(base, {
      method: "POST",
      body: { verificationId, loginId: loginId.trim(), password, broadcastNickname, agreedTerms, agreedPrivacy },
    });
    setBusy(false);
    if (r.ok) {
      setJoinedNickname(broadcastNickname);
      setStep("done");
      return;
    }
    if (commonFail(r)) return;
    const text = failMessage(r);
    switch (r.error) {
      case "invalid_login_id":
      case "login_id_taken":
        setFieldErrors({ loginId: text });
        break;
      case "weak_password":
        setFieldErrors({ password: text });
        break;
      case "invalid_nickname":
      case "nickname_taken":
        setFieldErrors({ nickname: text });
        break;
      case "terms_required":
        setFieldErrors({ terms: text });
        break;
      case "verification_pending":
        setStep("code");
        setNotice({ kind: "neg", text });
        break;
      case "verification_invalid":
      case "too_many_signup_attempts":
        restart({ kind: "neg", text });
        break;
      default:
        setNotice({ kind: r.error === "already_member" ? "info" : "neg", text });
    }
  };

  if (unavailable) {
    return <ShopState title="본인확인 서비스 준비 중이에요" body="휴대폰 본인확인을 할 수 있게 되면 바로 가입할 수 있어요. 잠시 뒤 다시 와 주세요." />;
  }

  if (step === "done") {
    return <ShopState done title="가입했어요" body={`첫 주문부터 적립돼요. 방송에서는 ${joinedNickname} 닉네임으로 보여요.`} />;
  }

  // 요청 중에도 잠가 보낸 값과 화면 값이 달라지지 않게 한다
  const locked = step !== "identity" || busy;
  const nicknameError = nicknameTooLong ? `닉네임은 ${MAX_NICKNAME_LENGTH}자까지 쓸 수 있어요` : fieldErrors.nickname;
  const shown = sent ?? { name: name.trim(), phone };
  return (
    <div className="card shop-card col signup">
      <div className="col" style={{ gap: 4 }}>
        <h1 className="t-t3">회원가입</h1>
        <span className="t-l2 c-alt">휴대폰 본인확인을 하고 가입해요 · 주문 내역과 적립금을 모아 봐요</span>
      </div>

      {notice && (
        <div className={`msg msg-${notice.kind}`} role={notice.kind === "neg" ? "alert" : "status"}>
          <span>{notice.text}</span>
        </div>
      )}

      {step === "verified" ? (
        <section className="col signup-sec" aria-label="본인확인">
          <div className="signup-done">
            <span className="tdot" aria-hidden />
            <span className="grow">
              <b>본인확인을 마쳤어요</b>
              <span className="c-alt"> · {shown.name} · {phoneText(shown.phone)}</span>
            </span>
            <button type="button" className="btn btn-sm btn-out" onClick={() => restart(null)}>
              다시 확인
            </button>
          </div>
          <div className="signup-two">
            <div className="fld">
              <label htmlFor="v-name">이름</label>
              <input id="v-name" className="inp" value={shown.name} readOnly />
            </div>
            <div className="fld">
              <label htmlFor="v-phone">휴대폰번호</label>
              <input id="v-phone" className="inp" value={phoneText(shown.phone)} readOnly />
            </div>
          </div>
          <span className="help">본인확인에서 받은 정보라 여기서는 고칠 수 없어요</span>
        </section>
      ) : (
        <form className="col signup-sec" aria-label="본인확인" onSubmit={sendCode} noValidate>
          <div className="col" style={{ gap: 2 }}>
            <h2 className="t-hl2">휴대폰 본인확인</h2>
            <span className="help">본인 명의의 휴대폰으로 인증해 주세요.</span>
          </div>
          <div className="fld">
            <label htmlFor="idv-name">이름</label>
            <input id="idv-name" className="inp" autoComplete="name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="idv-birth">생년월일</label>
            <input
              id="idv-birth"
              className={`inp${birthError ? " is-error" : ""}`}
              inputMode="numeric"
              placeholder="예: 19990101"
              value={birth}
              disabled={locked}
              onChange={(e) => {
                setBirth(digits(e.target.value, 8));
                setBirthError(null);
              }}
              aria-invalid={!!birthError}
              aria-describedby={birthError ? "idv-birth-err" : undefined}
            />
            {birthError && (
              <span id="idv-birth-err" className="err" role="alert">
                {birthError}
              </span>
            )}
          </div>
          <div className="signup-two">
            <div className="fld">
              <span className="lbl" id="idv-gender">성별</span>
              <div className="seg signup-seg" role="group" aria-labelledby="idv-gender">
                {(["M", "F"] as const).map((g) => (
                  <button key={g} type="button" className={gender === g ? "on" : ""} aria-pressed={gender === g} disabled={locked} onClick={() => setGender(g)}>
                    {g === "M" ? "남" : "여"}
                  </button>
                ))}
              </div>
            </div>
            <div className="fld">
              <span className="lbl" id="idv-nation">내·외국인</span>
              <div className="seg signup-seg" role="group" aria-labelledby="idv-nation">
                {[false, true].map((f) => (
                  <button key={String(f)} type="button" className={foreigner === f ? "on" : ""} aria-pressed={foreigner === f} disabled={locked} onClick={() => setForeigner(f)}>
                    {f ? "외국인" : "내국인"}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="fld">
            <label htmlFor="idv-carrier">통신사</label>
            <select id="idv-carrier" className="inp" value={carrier} disabled={locked} onChange={(e) => setCarrier(e.target.value as Carrier)}>
              <option value="" disabled>
                통신사를 골라 주세요
              </option>
              {CARRIERS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div className="fld">
            <label htmlFor="idv-phone">휴대폰번호</label>
            <input
              id="idv-phone"
              className="inp"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="숫자만 입력"
              value={phone}
              disabled={locked}
              onChange={(e) => setPhone(digits(e.target.value, 11))}
            />
          </div>
          {step === "identity" ? (
            <>
              <label className="chk">
                <input type="checkbox" className="cbx" checked={idvAgreed} onChange={(e) => setIdvAgreed(e.target.checked)} />
                본인확인 약관에 모두 동의해요
              </label>
              <button className={`btn btn-lg btn-block${busy ? " is-loading" : ""}`} type="submit" disabled={!identityReady || busy}>
                {busy ? "인증번호를 보내고 있어요" : "인증번호 받기"}
              </button>
            </>
          ) : (
            <div className="col" style={{ gap: 8 }}>
              <div className="fld">
                <label htmlFor="idv-code">인증번호</label>
                <div className="row" style={{ gap: 8 }}>
                  <input
                    id="idv-code"
                    className={`inp grow${codeError ? " is-error" : ""}`}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="6자리"
                    value={code}
                    onChange={(e) => {
                      setCode(digits(e.target.value, 6));
                      setCodeError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void confirm();
                      }
                    }}
                    aria-invalid={!!codeError}
                    aria-describedby={codeError ? "idv-code-err" : undefined}
                  />
                  <button type="button" className="btn" disabled={code.length !== 6 || busy} onClick={confirm}>
                    확인
                  </button>
                </div>
                {codeError && (
                  <span id="idv-code-err" className="err" role="alert">
                    {codeError}
                  </span>
                )}
              </div>
              <div className="row" style={{ gap: 4 }}>
                <button type="button" className="btn btn-sm btn-text" disabled={busy} onClick={resend}>
                  인증번호 다시 받기
                </button>
                <button type="button" className="btn btn-sm btn-text" disabled={busy} onClick={() => restart(null)}>
                  정보 다시 입력
                </button>
              </div>
            </div>
          )}
        </form>
      )}

      <form className="col signup-sec" aria-label="계정 정보" onSubmit={signup} noValidate>
        <fieldset className={`col signup-fs${step !== "verified" ? " is-waiting" : ""}`} disabled={step !== "verified" || busy}>
          <div className="fld">
            <label htmlFor="acc-id">아이디 (이메일)</label>
            <input
              id="acc-id"
              className={`inp${fieldErrors.loginId ? " is-error" : ""}`}
              type="email"
              autoComplete="username"
              placeholder="example@email.com"
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              aria-invalid={!!fieldErrors.loginId}
              aria-describedby={fieldErrors.loginId ? "acc-id-err" : undefined}
            />
            {fieldErrors.loginId && (
              <span id="acc-id-err" className="err" role="alert">
                {fieldErrors.loginId}
              </span>
            )}
          </div>
          <div className="fld">
            <label htmlFor="acc-pw">비밀번호</label>
            <input
              id="acc-pw"
              className={`inp${fieldErrors.password ? " is-error" : ""}`}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!fieldErrors.password}
              aria-describedby={fieldErrors.password ? "acc-pw-err" : "acc-pw-help"}
            />
            {fieldErrors.password ? (
              <span id="acc-pw-err" className="err" role="alert">
                {fieldErrors.password}
              </span>
            ) : (
              <span id="acc-pw-help" className="help">
                8자 이상으로 정해 주세요
              </span>
            )}
          </div>
          <div className="fld">
            <label htmlFor="acc-nick">방송 닉네임</label>
            <input
              id="acc-nick"
              className={`inp${nicknameError ? " is-error" : ""}`}
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              aria-invalid={!!nicknameError}
              aria-describedby={nicknameError ? "acc-nick-err" : "acc-nick-help"}
            />
            {nicknameError ? (
              <span id="acc-nick-err" className="err" role="alert">
                {nicknameError}
              </span>
            ) : (
              <span id="acc-nick-help" className="help">
                방송 화면에 보이는 이름이에요. 실명은 쓰지 마세요.
              </span>
            )}
          </div>
          <div className="col signup-terms">
            <label className="chk signup-all">
              <input
                type="checkbox"
                className="cbx"
                checked={agreedTerms && agreedPrivacy}
                onChange={(e) => {
                  setAgreedTerms(e.target.checked);
                  setAgreedPrivacy(e.target.checked);
                }}
              />
              필수 약관에 모두 동의해요
            </label>
            <label className="chk">
              <input type="checkbox" className="cbx" checked={agreedTerms} onChange={(e) => setAgreedTerms(e.target.checked)} />
              이용약관 (필수)
            </label>
            <label className="chk">
              <input type="checkbox" className="cbx" checked={agreedPrivacy} onChange={(e) => setAgreedPrivacy(e.target.checked)} />
              개인정보 수집 · 이용 (필수)
            </label>
            {fieldErrors.terms && (
              <span className="err" role="alert">
                {fieldErrors.terms}
              </span>
            )}
          </div>
          <div className="signup-cta">
            <button className={`btn btn-lg btn-block${busy && step === "verified" ? " is-loading" : ""}`} type="submit" disabled={!accountReady || busy}>
              {busy && step === "verified" ? "가입하고 있어요" : "가입하기"}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
