"use client";

import { useEffect, useRef, useState } from "react";
import { cleanText, textLength } from "../../lib/server/text/clean";
import { api, failMessage } from "./api";
import { stepOutcome } from "./stepFailure";

// SA-100 직원 계정(대표자 전용)에서 쓰는 권한 고르기·수정·비밀번호 재설정·비활성화 창.
// 권한 이름·설명은 디자인 SA-100과 같고, 키는 서버(lib/server/authz/permissions.ts STAFF_PERMISSIONS)와 같다.
export type StaffPerm =
  | "BROADCAST_RUN"
  | "OVERLAY_EDIT"
  | "PRODUCT_MANAGE"
  | "ORDER_SHIPPING"
  | "CUSTOMER_PII_VIEW"
  | "MEMBER_POINTS"
  | "INQUIRY_REPLY"
  | "RECEIPT_TAX"
  | "SALES_VIEW"
  | "SHOP_SETTINGS";

export const PERMS: { key: StaffPerm; label: string; desc: string }[] = [
  { key: "BROADCAST_RUN", label: "방송 진행", desc: "주문대기 · 개봉" },
  { key: "OVERLAY_EDIT", label: "오버레이 편집", desc: "오버레이 설정 · URL" },
  { key: "PRODUCT_MANAGE", label: "상품", desc: "등록 · 재고 · 카테고리" },
  { key: "ORDER_SHIPPING", label: "주문·배송", desc: "주문 처리 · 입금 확인 · 송장" },
  { key: "CUSTOMER_PII_VIEW", label: "고객 정보 보기", desc: "고객 이름·연락처·주소를 볼 수 있습니다" },
  { key: "MEMBER_POINTS", label: "회원·적립금", desc: "회원 · 구매 제한 · 적립금" },
  { key: "INQUIRY_REPLY", label: "문의 답변", desc: "구매자 문의" },
  { key: "RECEIPT_TAX", label: "영수증·세금계산서", desc: "발행 · 재발행" },
  { key: "SALES_VIEW", label: "매출 보기", desc: "홈 매출 · 정산 금액" },
  { key: "SHOP_SETTINGS", label: "쇼핑몰 설정", desc: "쇼핑몰 · 배송비 · 법정 고지 · 알림" },
];
const OWNER_ONLY = ["결제(PG) 연결", "구독 · 결제", "직원 관리", "적립금 실지급"];
// 묶음: 누른 뒤 개별로 고칠 수 있다. 「운영 전체」에 고객 정보 보기는 넣지 않는다(개인정보는 꼭 필요한 직원에게만 대표자가 따로 켬, MASTER 결정 2026-10-04)
const BUNDLES: { label: string; perms: StaffPerm[] }[] = [
  { label: "방송만", perms: ["BROADCAST_RUN", "OVERLAY_EDIT"] },
  { label: "운영 전체", perms: PERMS.map((p) => p.key).filter((k) => k !== "CUSTOMER_PII_VIEW") },
];

export type Staff = {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  identityLinked: boolean;
  permissions: StaffPerm[];
  status: "ACTIVE" | "DISABLED";
  lastLoginAt: string | null;
  createdAt: string;
};

// 직원 이름: 서버(lib/server/sellers/staffName.ts)와 같은 규칙. NFKC 뒤 코드포인트 50자까지, 제어·서식 문자(폭 없는 공백 등) 거부
export const STAFF_NAME_MAX = 50;
// 서버가 저장하는 모양(cleanStaffName: NFKC·앞뒤 공백 정리)으로 바꾼 이름. 저장 결과를 다시 읽어 비교할 때 쓴다
export const normStaffName = (v: string) => cleanText(v, STAFF_NAME_MAX) ?? v.trim();
export function staffNameError(v: string): string | null {
  if (!v.trim()) return "이름을 입력해 주십시오";
  if (textLength(v) > STAFF_NAME_MAX) return `이름은 ${STAFF_NAME_MAX}자까지 입력할 수 있습니다`;
  if (cleanText(v, STAFF_NAME_MAX) === null) return "이름에 사용할 수 없는 문자가 있습니다";
  return null;
}

export const MIN_PASSWORD_LENGTH = 8; // 서버(lib/server/auth/passwordReset.ts)와 같은 값
// 서버(normalizeStaffPhone)와 같은 규칙: 띄어쓰기·하이픈을 빼고 01로 시작하는 10~11자리
export const cleanPhone = (v: string) => v.normalize("NFKC").replace(/[ -]/g, "");
export const phoneOk = (v: string) => /^01\d{8,9}$/.test(cleanPhone(v));

// 서버 실패 이유 → 화면 문구(서버가 문구를 주지 않는 응답)
export const STAFF_ERRORS: Record<string, string> = {
  email_taken: "이미 사용 중인 이메일입니다",
  weak_password: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 정해 주십시오`,
  invalid_phone: "휴대폰 번호를 다시 확인해 주십시오",
  invalid_permissions: "권한을 다시 선택해 주십시오",
  bad_request: "입력 내용을 다시 확인해 주십시오",
};
// 새 비밀번호 칸: 기본은 가리고 「보기」로 잠깐 확인한다(화면 녹화·옆사람에게 그대로 보이지 않게).
// 값이 비워지면(만들기 성공 뒤 등) 다시 가린다: 다음 직원 비밀번호가 바로 보이지 않게
export function SecretInput(props: React.InputHTMLAttributes<HTMLInputElement> & { id: string }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (props.value === "") setShow(false);
  }, [props.value]);
  return (
    <div className="pw-wrap">
      <input {...props} type={show ? "text" : "password"} autoComplete="new-password" />
      <button className="btn btn-sm btn-text pw-toggle" type="button" onClick={() => setShow((v) => !v)} aria-pressed={show} aria-controls={props.id}>
        {show ? "숨기기" : "보기"}
      </button>
    </div>
  );
}

export const staffFail = (r: { status: number; error: string; message?: string }, fallback: string) => STAFF_ERRORS[r.error] ?? failMessage(r, fallback);

export function PermissionPicker({ value, onChange, disabled }: { value: StaffPerm[]; onChange: (v: StaffPerm[]) => void; disabled?: boolean }) {
  const toggle = (k: StaffPerm) => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k]);
  return (
    <fieldset className="col staff-perms" disabled={disabled}>
      <legend className="lbl">권한</legend>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <span className="t-c1 c-alt">묶음</span>
        {BUNDLES.map((b) => (
          <button key={b.label} className="btn btn-sm btn-out" type="button" onClick={() => onChange(b.perms)}>
            {b.label}
          </button>
        ))}
        <span className="t-c1 c-alt">선택 후 항목별로 수정할 수 있습니다</span>
      </div>
      <div className="col">
        {PERMS.map((p) => (
          <label key={p.key} className="row between staff-perm">
            <span className="col" style={{ gap: 1 }}>
              <span className="t-l1 fw6">{p.label}</span>
              <span className="t-c1 c-alt">{p.desc}</span>
            </span>
            <input className="cbx" type="checkbox" checked={value.includes(p.key)} onChange={() => toggle(p.key)} aria-label={p.label} />
          </label>
        ))}
        {OWNER_ONLY.map((label) => (
          <div key={label} className="row between staff-perm is-owner-only">
            <span className="col" style={{ gap: 1 }}>
              <span className="t-l1 fw6">{label}</span>
              <span className="t-c1 c-alt">대표자 전용</span>
            </span>
            <input className="cbx" type="checkbox" disabled aria-label={`${label} · 대표자만`} />
          </div>
        ))}
      </div>
    </fieldset>
  );
}

// 가운데 창: 처음 칸에 포커스, Esc로 닫기(보내는 중 제외)
function Dialog({ title, labelId, busy, onClose, children, wide }: { title: string; labelId: string; busy: boolean; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);
  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby={labelId}>
      <div className={`modal${wide ? " modal-lg" : ""} staff-modal`} ref={ref}>
        <div className="modal-h">
          <h3 className="t-hl1" id={labelId}>
            {title}
          </h3>
        </div>
        {children}
      </div>
    </div>
  );
}

export const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

// 직원 변경(추가·정보·권한 수정·비밀번호 재설정·비활성화)의 결과가 불분명할 때(연결 끊김·5xx, stepFailure.ts 기준) 공통 처리:
// 실패라고 단정하지 않고 지금 직원 목록을 다시 읽어 실제 상태로 판정한다. 목록으로 알 수 없는 것(비밀번호)은 같은 값으로만 다시 보내게 한다.
export async function readStaffList(): Promise<Staff[] | null> {
  const r = await api<{ staff: Staff[] }>("/api/seller/staff");
  return r.ok ? r.data.staff : null;
}
export const isUnclear = (r: { status: number; error: string }) => stepOutcome(r) === "retry";
// 결과가 불분명한 변경을 목록으로 확인한다: 목록을 읽어 판정 함수에 넘긴다. 목록을 읽지 못하면 null(아직 모름)
export async function settleByList<T>(judge: (list: Staff[]) => T): Promise<T | null> {
  const list = await readStaffList();
  return list ? judge(list) : null;
}


// 결과가 불분명한 동안 보여 주는 안내: 「확인」(목록을 다시 읽음)과 「재전송」(보낸 값 그대로 다시 보냄)만 누를 수 있다.
// 「없음」으로 읽혀도 실패로 확정하지 않는다: 첫 요청이 아직 서버에서 처리 중일 수 있기 때문(확실한 성공 증거가 있을 때만 푼다)
export function UnclearBox({ testId, title, text, busy, onCheck, onResend, resendLabel, extra }: { testId: string; title: string; text: string; busy: boolean; onCheck?: () => void; onResend: () => void; resendLabel: string; extra?: React.ReactNode }) {
  return (
    <div className="msg msg-cau" role="alert" style={{ display: "block" }} data-testid={testId}>
      <span>
        <b>{title}</b> {text}
      </span>
      <span className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {onCheck && (
          <button className="btn btn-sm" type="button" disabled={busy} onClick={onCheck}>
            확인
          </button>
        )}
        <button className={`btn btn-sm${onCheck ? " btn-out" : ""}`} type="button" disabled={busy} onClick={onResend}>
          {resendLabel}
        </button>
        {extra}
      </span>
    </div>
  );
}
export const UNCLEAR_PENDING = "아직 반영이 확인되지 않았습니다. 처리 중일 수 있으니 잠시 후 「확인」을 누르거나 같은 값으로 재전송해 주십시오";
export const UNCLEAR_UNREAD = "목록을 읽지 못해 결과를 확인하지 못했습니다. 잠시 후 「확인」을 눌러 주십시오";

type EditSent = { name: string; phone: string | null; perms: StaffPerm[]; profile: boolean; permissions: boolean };

// 직원 정보·권한 수정: 이름·휴대폰은 PATCH, 권한은 permissions로 보낸다(바뀐 것만)
// 결과가 불분명하면(연결 끊김·5xx) 칸을 잠그고, 목록에서 보낸 값과 같아진 것을 확인하거나 같은 값 재저장이 성공할 때만 저장으로 본다
export function EditStaffModal({ staff, onClose, onSaved, onChanged }: { staff: Staff; onClose: () => void; onSaved: (text: string) => void; onChanged?: () => void }) {
  const [name, setName] = useState(staff.name);
  const [phone, setPhone] = useState(staff.phone ?? "");
  const [perms, setPerms] = useState<StaffPerm[]>(staff.permissions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [unclear, setUnclear] = useState<{ sent: EditSent; text: string } | null>(null);
  const locked = busy || unclear !== null;
  const nextPhone = phone.trim() === "" ? null : cleanPhone(phone);
  const phoneChanged = nextPhone !== staff.phone;
  const profileChanged = name.trim() !== staff.name || phoneChanged;
  const permsChanged = !sameSet(perms, staff.permissions);
  const savedText = (sent: EditSent) =>
    sent.phone !== staff.phone && staff.identityLinked ? `${sent.name} 정보를 저장했습니다 · 다음 로그인 때 본인확인을 다시 안내합니다` : `${sent.name} 정보를 저장했습니다`;

  const check = async (sent: EditSent) => {
    setBusy(true);
    const cur = await settleByList((list) => list.find((s) => s.id === staff.id) ?? null);
    setBusy(false);
    if (!cur) return setUnclear({ sent, text: UNCLEAR_UNREAD });
    onChanged?.();
    if (cur.name === sent.name && cur.phone === sent.phone && sameSet(cur.permissions, sent.perms)) return onSaved(savedText(sent));
    setUnclear({ sent, text: UNCLEAR_PENDING });
  };

  // 보낸 값 그대로 보낸다(처음 저장과 재저장이 같은 경로). 불분명하면 불분명 상태로 두고 바로 한 번 확인한다
  const send = async (sent: EditSent, raw: { name: string }) => {
    setBusy(true);
    setError(null);
    setPhoneError(null);
    if (sent.profile) {
      const r = await api(`/api/seller/staff/${staff.id}`, { method: "PATCH", body: { name: raw.name, phone: sent.phone } });
      if (!r.ok) {
        if (isUnclear(r)) return check(sent);
        setBusy(false);
        if (unclear) return setUnclear({ sent, text: staffFail(r, "재저장하지 못했습니다. 잠시 후 「확인」을 눌러 주십시오") });
        if (r.error === "invalid_phone") return setPhoneError(STAFF_ERRORS.invalid_phone);
        return setError(staffFail(r, "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
      }
    }
    if (sent.permissions) {
      const r = await api(`/api/seller/staff/${staff.id}/permissions`, { method: "POST", body: { permissions: sent.perms } });
      if (!r.ok) {
        if (isUnclear(r)) return check(sent);
        setBusy(false);
        if (unclear) return setUnclear({ sent, text: staffFail(r, "재저장하지 못했습니다. 잠시 후 「확인」을 눌러 주십시오") });
        return setError(sent.profile ? `이름·휴대폰은 저장했지만 권한은 변경하지 못했습니다. ${staffFail(r, "다시 시도해 주십시오")}` : staffFail(r, "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
      }
    }
    setBusy(false);
    onSaved(savedText(sent));
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (locked) return;
    const nameError = staffNameError(name);
    if (nameError) return setError(nameError);
    if (nextPhone !== null && !phoneOk(phone)) return setPhoneError("01로 시작하는 휴대폰 번호를 숫자로 입력해 주십시오");
    void send({ name: normStaffName(name), phone: nextPhone, perms, profile: profileChanged, permissions: permsChanged }, { name: name.trim() });
  };

  // 불분명한 채로 닫으면 저장됐을 수 있음을 알리고 목록을 다시 읽는다
  const close = () => (unclear ? onSaved("이전 저장 요청이 처리되었을 수 있습니다 · 목록에서 정보와 권한을 확인해 주십시오") : onClose());

  return (
    <Dialog title={`${staff.name} 정보 · 권한 수정`} labelId="staff-edit-title" busy={busy} onClose={close} wide>
      <form className="col" style={{ gap: 14 }} onSubmit={save} noValidate>
        <p className="t-b2 c-neu" style={{ margin: 0 }}>
          {staff.email}
        </p>
        {unclear ? (
          <UnclearBox
            testId="se-unclear"
            title="저장되었을 수 있습니다."
            text={unclear.text}
            busy={busy}
            onCheck={() => void check(unclear.sent)}
            onResend={() => void send(unclear.sent, { name: name.trim() })}
            resendLabel="같은 값으로 재저장"
          />
        ) : (
          error && (
            <div className="msg msg-neg" role="alert">
              <span>{error}</span>
            </div>
          )
        )}
        <div className="pa-two">
          <div className="fld">
            <label htmlFor="se-name">이름</label>
            <input id="se-name" className="inp" value={name} disabled={locked} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="se-phone">휴대폰 번호</label>
            <input
              id="se-phone"
              className={`inp num${phoneError ? " is-error" : ""}`}
              inputMode="numeric"
              placeholder="숫자만 입력"
              value={phone}
              disabled={locked}
              onChange={(e) => {
                setPhone(e.target.value);
                setPhoneError(null);
              }}
              aria-invalid={!!phoneError}
              aria-describedby={phoneError ? "se-phone-err" : undefined}
            />
            {phoneError && (
              <span id="se-phone-err" className="err" role="alert">
                {phoneError}
              </span>
            )}
          </div>
        </div>
        {phoneChanged && staff.identityLinked ? (
          <div className="msg msg-cau" role="status" style={{ display: "block" }}>
            <b>번호를 바꾸면 직원이 본인확인을 다시 해야 합니다.</b> 저장하면 연결만 해제됩니다. 다시 연결하기 전까지는 아이디 · 비밀번호를 스스로 찾을 수 없으며, 다른 메뉴는 그대로 사용합니다.
          </div>
        ) : (
          <span className="t-c1 c-alt">
            {staff.phone === null ? "예전에 만든 직원은 비어 있습니다 · 입력하면 직원이 다음 로그인 때 휴대폰 본인확인으로 계정을 연결합니다" : "직원이 아이디 · 비밀번호를 찾을 때 본인확인에 사용합니다"}
          </span>
        )}
        <div className="row between staff-link">
          <span className="t-l1">계정 연결</span>
          <span className={`bdg ${staff.identityLinked && !phoneChanged ? "b-done" : "b-cancel"}`}>{staff.identityLinked && !phoneChanged ? "연결됨" : "본인확인 전"}</span>
        </div>
        <PermissionPicker value={perms} onChange={setPerms} disabled={locked} />
        <span className="t-c1 c-alt">저장하면 즉시 적용됩니다 · 직원이 로그인 중이면 다음 화면부터 반영됩니다 · 변경 기록은 로그 추적에 남습니다</span>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={close} disabled={busy}>
            {unclear ? "닫기" : "취소"}
          </button>
          <button className={`btn${busy ? " is-loading" : ""}`} type="submit" disabled={locked || (!profileChanged && !permsChanged)}>
            {busy ? "저장 중" : "저장"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// 비밀번호는 목록으로 확인할 수 없다: 결과가 불분명하면 「변경되었을 수 있음」을 알리고, 칸을 잠근 채 같은 값으로만 재전송하게 한다.
// 첫 요청이 아직 처리 중일 수 있어 다른 비밀번호로 바꾸는 길은 두지 않는다(늦게 끝난 첫 요청이 새 비밀번호를 덮을 수 있음). 재전송 성공만 확정으로 본다
export function ResetPasswordModal({ staff, onClose, onDone }: { staff: Staff; onClose: () => void; onDone: (text: string) => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unclear, setUnclear] = useState<string | null>(null);

  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (pw.length < MIN_PASSWORD_LENGTH) return setError(`${MIN_PASSWORD_LENGTH}자 이상으로 정해 주십시오`);
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/staff/${staff.id}/password`, { method: "POST", body: { newPassword: pw } });
    setBusy(false);
    if (r.ok) return onDone(`${staff.name} 비밀번호를 변경했습니다 · 직원에게 직접 전달해 주십시오`);
    if (isUnclear(r)) return setUnclear("결과를 확인하지 못했습니다. 같은 비밀번호로 재전송해 주십시오");
    if (unclear) return setUnclear(staffFail(r, "재전송하지 못했습니다. 잠시 후 다시 재전송해 주십시오"));
    setError(staffFail(r, "변경하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
  };

  const close = () => (unclear ? onDone(`이전 비밀번호 재설정 요청이 처리되었을 수 있습니다 · ${staff.name} 로그인이 되지 않으면 입력한 비밀번호를 전달해 주십시오`) : onClose());

  return (
    <Dialog title={`${staff.name} 비밀번호를 재설정하시겠습니까?`} labelId="staff-pw-title" busy={busy} onClose={close}>
      <form className="col" style={{ gap: 14 }} onSubmit={submit} noValidate>
        {unclear && <UnclearBox testId="sp-unclear" title="비밀번호가 변경되었을 수 있습니다." text={unclear} busy={busy} onResend={() => void submit()} resendLabel="같은 비밀번호로 재전송" />}
        <div className="fld">
          <label htmlFor="sp-new">새 비밀번호</label>
          <SecretInput
            id="sp-new"
            className={`inp${error ? " is-error" : ""}`}
            maxLength={200}
            value={pw}
            disabled={busy || unclear !== null}
            onChange={(e) => {
              setPw(e.target.value);
              setError(null);
            }}
            aria-invalid={!!error}
            aria-describedby={error ? "sp-new-err" : "sp-new-help"}
          />
          {error ? (
            <span id="sp-new-err" className="err" role="alert">
              {error}
            </span>
          ) : (
            <span id="sp-new-help" className="help">
              {MIN_PASSWORD_LENGTH}자 이상 · 직원에게 직접 전달해 주십시오
            </span>
          )}
        </div>
        <span className="t-l2 c-neu">변경하면 {staff.name}의 다른 기기 로그인이 모두 해제됩니다.</span>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={close} disabled={busy}>
            {unclear ? "닫기" : "취소"}
          </button>
          <button className={`btn${busy ? " is-loading" : ""}`} type="submit" disabled={busy || unclear !== null || pw === ""}>
            {busy ? "변경 중" : "재설정"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

// 비활성화: 결과가 불분명하면 목록에서 DISABLED를 확인하거나 재전송이 성공할 때만 완료로 본다(서버의 비활성화는 다시 보내도 같은 결과)
export function DisableStaffModal({ staff, onClose, onDone, onChanged }: { staff: Staff; onClose: () => void; onDone: (text: string) => void; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unclear, setUnclear] = useState<string | null>(null);
  const doneText = `${staff.name} 계정을 비활성화했습니다`;

  const check = async () => {
    setBusy(true);
    const cur = await settleByList((list) => list.find((s) => s.id === staff.id) ?? null);
    setBusy(false);
    if (!cur) return setUnclear(UNCLEAR_UNREAD);
    onChanged?.();
    if (cur.status === "DISABLED") return onDone(doneText);
    setUnclear(UNCLEAR_PENDING);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/staff/${staff.id}/disable`, { method: "POST" });
    if (r.ok) {
      setBusy(false);
      return onDone(doneText);
    }
    if (isUnclear(r)) return check();
    setBusy(false);
    if (unclear) return setUnclear(failMessage(r, "재전송하지 못했습니다. 잠시 후 「확인」을 눌러 주십시오"));
    setError(failMessage(r, "비활성화하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
  };

  const close = () => (unclear ? onDone("이전 비활성화 요청이 처리되었을 수 있습니다 · 목록에서 상태를 확인해 주십시오") : onClose());

  return (
    <Dialog title={`${staff.name} 계정을 비활성화하시겠습니까?`} labelId="staff-disable-title" busy={busy} onClose={close}>
      <p className="t-b2 c-neu" style={{ margin: 0 }}>
        즉시 로그아웃되며 다시 로그인할 수 없습니다. 처리 기록은 로그 추적에 남습니다.
      </p>
      {unclear ? (
        <UnclearBox testId="sd-unclear" title="비활성화되었을 수 있습니다." text={unclear} busy={busy} onCheck={() => void check()} onResend={() => void submit()} resendLabel="재전송" />
      ) : (
        error && (
          <div className="msg msg-neg" role="alert">
            <span>{error}</span>
          </div>
        )
      )}
      <div className="modal-f">
        <button className="btn btn-out" type="button" onClick={close} disabled={busy}>
          {unclear ? "닫기" : "취소"}
        </button>
        <button className={`btn btn-neg${busy ? " is-loading" : ""}`} type="button" onClick={() => void submit()} disabled={busy || unclear !== null}>
          {busy ? "비활성화 중" : "비활성화"}
        </button>
      </div>
    </Dialog>
  );
}
