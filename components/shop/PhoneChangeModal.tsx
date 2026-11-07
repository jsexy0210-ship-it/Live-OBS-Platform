"use client";

import { Fragment, useState } from "react";
import ShopModal from "./ShopModal";
import { call } from "./reviewShared";
import { CARRIERS, digits, phoneText, toBirth7, type Carrier } from "./signup/SignupFlow";
import "./signup/Signup.css";
import "./Profile.css";

// SH-024 「번호 바꾸기 (본인확인)」 창(보드 SH-024-IA 상태 변형, 항목·순서·문구는 가입 2/4 SH-011-2와 같고 번호 라벨만 「새 휴대폰번호」):
// 1/4 새 번호 본인확인 입력 → 2/4 인증번호 → 3/4 본인확인 완료 → 「이 번호로 바꾸기」 → 4/4 완료(창 닫힘, 행에 새 번호).
// API(서버 #1327): POST /me/phone/verification { name, phone, birth7, carrier, device } → …/verification/resend · …/confirm { verificationId, code } → POST /me/phone { verificationId }.
// 창을 닫으면 처음부터다. 오류 문구는 서버 message를 그대로 쓴다. 서버 만료 시각을 주지 않아 보드의 「남은 시간」은 그리지 않는다(docs/UI_STATUS.md).
type Stage = "input" | "code" | "verified";
type Failure = { text: string; restart: boolean };

export default function PhoneChangeModal({ api, onClose, onDone, onUnavailable }: { api: string; onClose: () => void; onDone: () => void; onUnavailable: () => void }) {
  const [stage, setStage] = useState<Stage>("input");
  const [name, setName] = useState("");
  const [birth, setBirth] = useState("");
  const [gender, setGender] = useState<"M" | "F" | null>(null);
  const [foreigner, setForeigner] = useState(false);
  const [carrier, setCarrier] = useState<Carrier | "">("");
  const [phone, setPhone] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [code, setCode] = useState("");
  const [vid, setVid] = useState<string | null>(null);
  const [identity, setIdentity] = useState<{ name: string; phone: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [fieldErr, setFieldErr] = useState<{ birth?: string; phone?: string; code?: string } | null>(null);
  const [fail, setFail] = useState<Failure | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const filled = name.trim() !== "" && birth.length === 8 && gender !== null && carrier !== "" && phone.length >= 10 && agreed;

  const reset = () => {
    setStage("input");
    setVid(null);
    setCode("");
    setIdentity(null);
    setFail(null);
    setInfo(null);
    setFieldErr(null);
  };

  async function sendCode() {
    if (!filled || busy || locked) return;
    const birth7 = toBirth7(birth, gender, foreigner);
    if (!birth7) return setFieldErr({ birth: "생년월일 8자리를 다시 확인해 주세요" });
    setBusy(true);
    setFail(null);
    setInfo(null);
    setFieldErr(null);
    const device = window.matchMedia("(min-width: 768px)").matches ? "PC" : "MOBILE";
    const r = await call<{ verificationId: string }>(`${api}/phone/verification`, { method: "POST", body: { name: name.trim(), phone, birth7, carrier, device } });
    setBusy(false);
    if (r.ok) {
      setVid(r.data.verificationId);
      setStage("code");
      return;
    }
    if (r.error === "same_phone") return setFieldErr({ phone: r.message ?? "지금 쓰는 번호와 다른 번호를 입력해 주세요" });
    // 대행사 계약 전(503 identity_unavailable): 창을 닫고 행의 버튼을 잠근다
    if (r.error === "identity_unavailable") {
      onUnavailable();
      return setLocked("본인확인 서비스 준비 중이에요");
    }
    if (r.error === "daily_limit_exceeded" || r.error === "phone_change_unavailable") return setLocked(r.message ?? "지금은 번호를 바꿀 수 없어요. 쇼핑몰에 문의해 주세요");
    setFail({ text: r.message ?? "인증번호를 보내지 못했어요. 잠시 뒤 다시 해 주세요", restart: false });
  }

  async function resend() {
    if (!vid || busy) return;
    setBusy(true);
    setFieldErr(null);
    const r = await call(`${api}/phone/verification/resend`, { method: "POST", body: { verificationId: vid } });
    setBusy(false);
    if (r.ok) {
      setCode("");
      return setInfo("인증번호를 다시 보냈어요");
    }
    setInfo(null);
    setFieldErr({ code: r.message ?? "인증번호를 다시 보내지 못했어요. 잠시 뒤 다시 해 주세요" });
  }

  async function confirm() {
    if (!vid || busy || code.length !== 6) return;
    setBusy(true);
    setFieldErr(null);
    setInfo(null);
    const r = await call<{ identity?: { name: string; phone: string } }>(`${api}/phone/verification/confirm`, { method: "POST", body: { verificationId: vid, code } });
    setBusy(false);
    if (r.ok) {
      setIdentity(r.data.identity ?? { name: name.trim(), phone });
      return setStage("verified");
    }
    setFieldErr({ code: r.message ?? "인증번호를 확인하지 못했어요. 잠시 뒤 다시 해 주세요" });
  }

  async function apply() {
    if (!vid || busy) return;
    setBusy(true);
    setFail(null);
    const r = await call(`${api}/phone`, { method: "POST", body: { verificationId: vid } });
    setBusy(false);
    if (r.ok) return onDone();
    const text = r.message ?? "번호를 바꾸지 못했어요. 잠시 뒤 다시 해 주세요";
    // 확인 전(409 verification_pending)은 창을 유지하고, 그 밖의 거절은 처음부터 다시 한다
    setFail({ text, restart: r.error !== "verification_pending" && r.status !== 0 && r.status < 500 });
  }

  const title = "번호 바꾸기 (본인확인)";
  return (
    <ShopModal
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        stage === "input" ? (
          <Fragment key="input">
            <button className="btn btn-out" type="button" disabled={busy} onClick={onClose}>
              취소
            </button>
            <button className="btn" type="submit" form="phone-change-form" disabled={!filled || busy || !!locked}>
              {busy ? "인증번호를 보내고 있어요" : "인증번호 문자 받기"}
            </button>
          </Fragment>
        ) : stage === "code" ? (
          <Fragment key="code">
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => void resend()}>
              다시 받기
            </button>
            <button className="btn" type="button" disabled={code.length !== 6 || busy} onClick={() => void confirm()}>
              인증번호 확인하기
            </button>
          </Fragment>
        ) : fail?.restart ? (
          <Fragment key="restart">
            <button className="btn btn-out" type="button" onClick={onClose}>
              취소
            </button>
            <button className="btn" type="button" onClick={reset}>
              처음부터 다시
            </button>
          </Fragment>
        ) : (
          <Fragment key="apply">
            <button className="btn btn-out" type="button" disabled={busy} onClick={reset}>
              다시 하기
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void apply()}>
              이 번호로 바꾸기
            </button>
          </Fragment>
        )
      }
    >
      <div className="pf-modal pc-modal">
        {stage === "input" && (
          <form
            id="phone-change-form"
            className="col sg-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void sendCode();
            }}
          >
            <p className="msg msg-info t-l2" style={{ display: "block" }}>
              본인 명의 새 휴대폰으로 확인해요 · 가입할 때 본인확인한 분의 번호만 돼요
            </p>
            <div className="fld">
              <label htmlFor="pc-name">
                이름<i aria-hidden="true">*</i>
              </label>
              <input id="pc-name" className="inp" autoComplete="name" placeholder="본인 이름" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="fld">
              <label htmlFor="pc-birth">
                생년월일<i aria-hidden="true">*</i>
              </label>
              <input
                id="pc-birth"
                className={`inp${fieldErr?.birth ? " is-error" : ""}`}
                inputMode="numeric"
                placeholder="예: 19990101"
                value={birth}
                disabled={busy}
                aria-invalid={!!fieldErr?.birth}
                onChange={(e) => {
                  setBirth(digits(e.target.value, 8));
                  setFieldErr(null);
                }}
              />
              {fieldErr?.birth ? (
                <span className="err" role="alert">
                  {fieldErr.birth}
                </span>
              ) : (
                <span className="help">숫자 8자리</span>
              )}
            </div>
            <div className="signup-two">
              <div className="fld">
                <span className="lbl" id="pc-gender">
                  성별<i aria-hidden="true">*</i>
                </span>
                <div className="seg signup-seg" role="group" aria-labelledby="pc-gender">
                  {(["M", "F"] as const).map((g) => (
                    <button key={g} type="button" className={gender === g ? "on" : ""} aria-pressed={gender === g} disabled={busy} onClick={() => setGender(g)}>
                      {g === "M" ? "남" : "여"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="fld">
                <span className="lbl" id="pc-nation">
                  내 · 외국인<i aria-hidden="true">*</i>
                </span>
                <div className="seg signup-seg" role="group" aria-labelledby="pc-nation">
                  {[false, true].map((x) => (
                    <button key={String(x)} type="button" className={foreigner === x ? "on" : ""} aria-pressed={foreigner === x} disabled={busy} onClick={() => setForeigner(x)}>
                      {x ? "외국인" : "내국인"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="fld">
              <label htmlFor="pc-carrier">
                통신사<i aria-hidden="true">*</i>
              </label>
              <select id="pc-carrier" className="inp" value={carrier} disabled={busy} onChange={(e) => setCarrier(e.target.value as Carrier)}>
                <option value="" disabled>
                  선택
                </option>
                {CARRIERS.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="fld">
              <label htmlFor="pc-phone">
                새 휴대폰번호<i aria-hidden="true">*</i>
              </label>
              <input
                id="pc-phone"
                className={`inp${fieldErr?.phone ? " is-error" : ""}`}
                inputMode="numeric"
                autoComplete="tel-national"
                placeholder="숫자만 입력"
                value={phone}
                disabled={busy}
                aria-invalid={!!fieldErr?.phone}
                onChange={(e) => {
                  setPhone(digits(e.target.value, 11));
                  setFieldErr(null);
                }}
              />
              {fieldErr?.phone && (
                <span className="err" role="alert">
                  {fieldErr.phone}
                </span>
              )}
            </div>
            <label className="chk">
              <input type="checkbox" className="cbx" checked={agreed} disabled={busy} onChange={(e) => setAgreed(e.target.checked)} />
              본인확인 이용 약관에 모두 동의해요
            </label>
            <p className="pf-hint">하루 3번까지 할 수 있어요(실패 포함) · 번호와 생년월일이 본인확인 값으로 바뀌어요 · 다른 기기 로그인은 그대로예요</p>
            {locked && (
              <p className="msg msg-neg t-l2" role="alert" style={{ display: "block" }}>
                {locked}
              </p>
            )}
          </form>
        )}
        {stage === "code" && (
          <div className="col sg-code">
            <p className="msg msg-info t-l2" style={{ display: "block" }}>
              인증번호를 보냈어요. 문자로 받은 6자리를 넣어 주세요
            </p>
            <div className="fld">
              <label htmlFor="pc-code">
                인증번호<i aria-hidden="true">*</i>
              </label>
              <input
                id="pc-code"
                className={`inp${fieldErr?.code ? " is-error" : ""}`}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6자리"
                value={code}
                aria-invalid={!!fieldErr?.code}
                onChange={(e) => {
                  setCode(digits(e.target.value, 6));
                  setFieldErr(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void confirm();
                  }
                }}
              />
              {fieldErr?.code ? (
                <span className="err" role="alert">
                  {fieldErr.code}
                </span>
              ) : (
                <span className="help">못 받았으면 「다시 받기」를 눌러 주세요</span>
              )}
            </div>
            {info && (
              <p className="msg msg-pos t-l2" role="status" style={{ display: "block" }}>
                {info}
              </p>
            )}
          </div>
        )}
        {stage === "verified" && (
          <>
            <section className="sg-verified" aria-label="본인확인 결과">
              <span className="bdg b-done">본인확인 완료</span>
              <span className="sg-verified-text">
                <b>
                  {identity?.name} · {phoneText(identity?.phone ?? phone)}
                  {birth.length === 8 ? ` · ${birth.slice(0, 4)}년생` : ""}
                </b>
                <span className="c-alt">방금 확인했어요 · 바꿀 수 없어요</span>
              </span>
            </section>
            <p className="pf-hint">「이 번호로 바꾸기」를 눌러야 바뀌어요 · 다른 기기 로그인은 그대로예요</p>
            {fail && (
              <p className="msg msg-neg t-l2" role="alert" style={{ display: "block" }}>
                {fail.text}
              </p>
            )}
          </>
        )}
        {stage === "input" && fail && (
          <p className="msg msg-neg t-l2" role="alert" style={{ display: "block" }}>
            {fail.text}
          </p>
        )}
      </div>
    </ShopModal>
  );
}
