"use client";

import { useEffect, useRef, useState } from "react";
import { api, failMessage, type ApiResult } from "./api";

// 파트너스 가입(PF-007)·비밀번호 찾기(AU-003)에서 함께 쓰는 대표자 휴대폰 본인확인 칸.
// 인적사항 → 인증번호 받기(start) → 6자리 확인(base/confirm) → onVerified. 다시 받기는 base/resend.
// 실패 문구는 서버 message를 그대로 쓴다(정본: lib/server/identity/messages.ts). 503(본인확인 서비스 준비 중)은 onUnavailable로 넘긴다.
export type Carrier = "SKT" | "KT" | "LGU" | "SKT_MVNO" | "KT_MVNO" | "LGU_MVNO";
const CARRIERS: { value: Carrier; label: string }[] = [
  { value: "SKT", label: "SKT" },
  { value: "KT", label: "KT" },
  { value: "LGU", label: "LG U+" },
  { value: "SKT_MVNO", label: "알뜰폰 (SKT망)" },
  { value: "KT_MVNO", label: "알뜰폰 (KT망)" },
  { value: "LGU_MVNO", label: "알뜰폰 (LG U+망)" },
];

// device: 본인확인 대행사에 보내는 기기 구분(PC는 768px 이상, 구매자 가입과 같은 기준)
export type IdentityPerson = { name: string; phone: string; birth7: string; carrier: Carrier; device: "PC" | "MOBILE" };
type Fail = { status: number; error: string; message?: string; body?: Record<string, unknown> };

// 서버가 문구를 주지 않는 하루 한도 응답(429)
const LIMIT_MESSAGES: Record<string, string> = {
  daily_limit_exceeded: "오늘은 본인확인을 더 할 수 없어요. 내일 다시 해 주세요",
  reset_limit_exceeded: "오늘은 비밀번호 찾기를 더 할 수 없어요. 내일 다시 해 주세요",
};
export const identityFailText = (r: Fail) => LIMIT_MESSAGES[r.error] ?? failMessage(r);

const digits = (v: string, max: number) => v.replace(/\D/g, "").slice(0, max);
// 한국 날짜(YYYYMMDD). 미래 날짜 검사는 한국 달력 기준(UTC로 비교하면 00:00~08:59 KST에 오늘을 미래로 본다)
export const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");

export const phoneText = (p: string) => (p.length === 11 ? `${p.slice(0, 3)}-${p.slice(3, 7)}-${p.slice(7)}` : `${p.slice(0, 3)}-${p.slice(3, 6)}-${p.slice(6)}`);

// 생년월일 8자리 + 성별 + 내·외국인 → 서버가 받는 birth7(YYMMDD + 성별 자리). 1900년대 1·2, 2000년대 3·4, 외국인은 5~8.
function toBirth7(birth: string, gender: "M" | "F", foreigner: boolean): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(birth);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1900 || y > 2099 || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || birth > kstToday()) return null;
  const base = (y >= 2000 ? 3 : 1) + (gender === "F" ? 1 : 0) + (foreigner ? 4 : 0);
  return `${m[1].slice(2)}${m[2]}${m[3]}${base}`;
}

type Props = {
  label: string;
  // 인증번호 받기. 성공하면 verificationId. attemptKey는 시작 요청 본문에 함께 보낸다(응답을 잃고 다시 보내도 문자·하루 횟수를 다시 쓰지 않게)
  start: (person: IdentityPerson, attemptKey: string) => Promise<ApiResult<{ verificationId: string }>>;
  // 인적사항 밖에서 시작 요청에 함께 보내는 값(예: 이메일·쇼핑몰 주소). 바뀌면 새 시도로 본다
  scope?: string;
  // 다시 받기·확인 API 앞부분(…/verification, …/password-reset)
  base: string;
  // 인증번호 받기 전에 채워야 하는 다른 칸이 비었으면 true(버튼을 끈다)
  blocked?: boolean;
  onVerified: (verificationId: string, who: { name: string; phone: string }) => void;
  onUnavailable: () => void;
  // 인증번호 받기 요청을 보내는 중이거나 인증번호를 보낸 동안 true(부모는 인증 요청에 쓴 다른 칸을 잠근다).
  // 보내는 중에도 잠가야 보낸 값(동의·이메일 등)과 화면이 어긋나지 않는다. 요청이 실패하면 다시 false
  onSentChange?: (sent: boolean) => void;
  // 시작 거절을 부모가 자기 칸에서 안내하면 true(예: 가입 필수 동의). 그때는 이 칸에 안내를 따로 띄우지 않는다
  onStartRefused?: (r: Fail) => boolean;
};

export default function IdentityCheck({ label, start, scope = "", base, blocked = false, onVerified, onUnavailable, onSentChange, onStartRefused }: Props) {
  const [step, setStep] = useState<"identity" | "code">("identity");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: "neg" | "info"; text: string } | null>(null);
  const [name, setName] = useState("");
  const [birth, setBirth] = useState("");
  const [gender, setGender] = useState<"M" | "F" | null>(null);
  const [foreigner, setForeigner] = useState(false);
  const [carrier, setCarrier] = useState<Carrier | "">("");
  const [phone, setPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [birthError, setBirthError] = useState<string | null>(null);
  const [verificationId, setVerificationId] = useState<string | null>(null);
  // 본인확인 시작 한 번(같은 입력)의 멱등 키(구매자 가입 SignupForm과 같은 방식). 응답이 끊겨 다시 누르면 같은 키로 보낸다.
  // 입력을 바꾸거나, 시작에 성공했거나, 그 키로는 다시 시작할 수 없다는 답(확인됨·만료·실패)을 받으면 새 키를 만든다.
  const attempt = useRef<{ fp: string; key: string } | null>(null);
  const [sent, setSent] = useState<{ name: string; phone: string } | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [focusTo, setFocusTo] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (!focusTo) return;
    document.getElementById(focusTo.id)?.focus();
    setFocusTo(null);
  }, [focusTo]);
  const focus = (id: string) => setFocusTo({ id });

  useEffect(() => onSentChange?.(step === "code" || busy), [step, busy, onSentChange]);

  const ready = !blocked && name.trim() !== "" && birth.length === 8 && gender !== null && carrier !== "" && phone.length >= 10 && agreed;
  const locked = step === "code" || busy;

  const restart = (text: string | null) => {
    setVerificationId(null);
    setSent(null);
    setCode("");
    setCodeError(null);
    setStep("identity");
    setNotice(text ? { kind: "neg", text } : null);
    focus(text ? "idv-notice" : "idv-name");
  };

  // 503은 상태 화면으로, 나머지는 안내로
  const fail = (r: Fail) => {
    if (r.status === 503) return onUnavailable();
    setNotice({ kind: "neg", text: identityFailText(r) });
    focus("idv-notice");
  };

  const sendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy || gender === null) return;
    const birth7 = toBirth7(birth, gender, foreigner);
    if (!birth7) {
      setBirthError("생년월일 8자리를 다시 확인해 주세요");
      focus("idv-birth");
      return;
    }
    setBusy(true);
    setNotice(null);
    setBirthError(null);
    const person = { name: name.trim(), phone };
    const device = window.matchMedia("(min-width: 768px)").matches ? "PC" : "MOBILE";
    const input: IdentityPerson = { ...person, birth7, carrier, device };
    const fp = JSON.stringify([scope, input]);
    if (attempt.current?.fp !== fp) attempt.current = { fp, key: crypto.randomUUID() };
    const r = await start(input, attempt.current.key);
    setBusy(false);
    // 409 start_in_progress(앞 요청이 아직 문자를 보내는 중)·연결 끊김·일시 오류는 키를 두어 다시 누르면 같은 시도로 이어 간다
    if (r.ok || r.error === "already_verified" || r.error === "expired" || r.error === "failed") attempt.current = null;
    if (!r.ok) return onStartRefused?.(r) ? undefined : fail(r);
    setVerificationId(r.data.verificationId);
    setSent(person);
    setCode("");
    setCodeError(null);
    setStep("code");
    setNotice({ kind: "info", text: "인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요" });
    focus("idv-code");
  };

  const resend = async () => {
    if (!verificationId || busy) return;
    setBusy(true);
    setCodeError(null);
    const r = await api(`${base}/resend`, { method: "POST", body: { verificationId } });
    setBusy(false);
    if (r.ok) {
      setCode("");
      setNotice({ kind: "info", text: "인증번호를 다시 보냈어요" });
      focus("idv-code");
      return;
    }
    if (r.status === 503) return onUnavailable();
    if (r.error === "already_verified") return onVerified(verificationId, sent!);
    if (r.error === "resend_too_soon") {
      setNotice({ kind: "info", text: identityFailText(r) });
      focus("idv-code");
    } else if (r.status === 0 || r.error === "provider_error") fail(r);
    else restart(identityFailText(r));
  };

  const confirm = async () => {
    if (!verificationId || busy || code.length !== 6) return;
    setBusy(true);
    setCodeError(null);
    const r = await api(`${base}/confirm`, { method: "POST", body: { verificationId, code } });
    setBusy(false);
    if (r.ok || r.error === "already_verified") return onVerified(verificationId, sent!);
    if (r.status === 503) return onUnavailable();
    if (r.error === "wrong_code" || r.error === "code_expired") {
      setNotice(null);
      setCodeError(identityFailText(r));
      focus("idv-code");
    } else if (r.status === 0 || r.error === "provider_error") fail(r);
    else restart(identityFailText(r));
  };

  return (
    <form className="col pa-sec" aria-label={label} onSubmit={sendCode} noValidate>
      <div className="col" style={{ gap: 2 }}>
        <span className="lbl req">{label}</span>
        <span className="help">본인 명의의 휴대폰으로 인증해 주세요.</span>
      </div>
      {notice && (
        <div id="idv-notice" tabIndex={-1} className={`msg msg-${notice.kind}`} role={notice.kind === "neg" ? "alert" : "status"}>
          <span>{notice.text}</span>
        </div>
      )}
      <div className="col pa-idv">
        <div className="pa-two">
          <div className="fld">
            <label htmlFor="idv-name">이름</label>
            <input id="idv-name" className="inp" autoComplete="name" value={name} disabled={locked} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="idv-birth">생년월일</label>
            <input
              id="idv-birth"
              className={`inp num${birthError ? " is-error" : ""}`}
              inputMode="numeric"
              placeholder="예: 19900101"
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
        </div>
        <div className="pa-two">
          <div className="fld">
            <span className="lbl" id="idv-gender">
              성별
            </span>
            <div className="seg pa-seg" role="group" aria-labelledby="idv-gender">
              {(["M", "F"] as const).map((g) => (
                <button key={g} type="button" className={gender === g ? "on" : ""} aria-pressed={gender === g} disabled={locked} onClick={() => setGender(g)}>
                  {g === "M" ? "남" : "여"}
                </button>
              ))}
            </div>
          </div>
          <div className="fld">
            <span className="lbl" id="idv-nation">
              내·외국인
            </span>
            <div className="seg pa-seg" role="group" aria-labelledby="idv-nation">
              {[false, true].map((f) => (
                <button key={String(f)} type="button" className={foreigner === f ? "on" : ""} aria-pressed={foreigner === f} disabled={locked} onClick={() => setForeigner(f)}>
                  {f ? "외국인" : "내국인"}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="pa-two pa-carrier">
          <div className="fld">
            <label htmlFor="idv-carrier">통신사</label>
            <select id="idv-carrier" className="inp" value={carrier} disabled={locked} onChange={(e) => setCarrier(e.target.value as Carrier)}>
              <option value="" disabled>
                골라 주세요
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
              className="inp num"
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="숫자만 입력"
              value={phone}
              disabled={locked}
              onChange={(e) => setPhone(digits(e.target.value, 11))}
            />
          </div>
        </div>
        {step === "identity" ? (
          <>
            <label className="chk">
              <input type="checkbox" className="cbx" checked={agreed} disabled={busy} onChange={(e) => setAgreed(e.target.checked)} />
              본인확인 약관에 모두 동의해요
            </label>
            <button className={`btn btn-block${busy ? " is-loading" : ""}`} type="submit" disabled={!ready || busy}>
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
                  className={`inp grow num${codeError ? " is-error" : ""}`}
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
                <button type="button" className="btn" disabled={code.length !== 6 || busy} onClick={() => void confirm()}>
                  확인
                </button>
              </div>
              {codeError && (
                <span id="idv-code-err" className="err" role="alert">
                  {codeError}
                </span>
              )}
            </div>
            <div className="row wrap" style={{ gap: 4 }}>
              <button type="button" className="btn btn-sm btn-text" disabled={busy} onClick={() => void resend()}>
                인증번호 다시 받기
              </button>
              <button type="button" className="btn btn-sm btn-text" disabled={busy} onClick={() => restart(null)}>
                정보 다시 입력
              </button>
            </div>
          </div>
        )}
      </div>
    </form>
  );
}

// 본인확인을 마친 뒤 보여 주는 칸(PF-007 「본인확인을 마쳤어요」)
export function IdentityDone({ who, onAgain, disabled }: { who: { name: string; phone: string }; onAgain?: () => void; disabled?: boolean }) {
  return (
    <div className="col pa-sec">
      <div className="pa-done" role="status">
        <span className="tdot" aria-hidden />
        <span className="pa-done-text">
          <b>본인확인을 마쳤어요</b>
          <span className="c-alt pa-done-who">
            <span className="nw">{who.name} ·</span> <span className="nw num">{phoneText(who.phone)}</span>
          </span>
        </span>
        {onAgain && (
          <button type="button" className="btn btn-sm btn-out" disabled={disabled} onClick={onAgain}>
            다시 확인
          </button>
        )}
      </div>
    </div>
  );
}
