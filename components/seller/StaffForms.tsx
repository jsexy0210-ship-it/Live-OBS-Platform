"use client";

import { useEffect, useRef, useState } from "react";
import { api, failMessage } from "./api";

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
  { key: "CUSTOMER_PII_VIEW", label: "고객 정보 보기", desc: "이름 · 연락처 · 주소" },
  { key: "MEMBER_POINTS", label: "회원·적립금", desc: "회원 · 구매 제한 · 적립금" },
  { key: "INQUIRY_REPLY", label: "문의 답변", desc: "구매자 문의" },
  { key: "RECEIPT_TAX", label: "영수증·세금계산서", desc: "발행 · 재발행" },
  { key: "SALES_VIEW", label: "매출 보기", desc: "홈 매출 · 정산 금액" },
  { key: "SHOP_SETTINGS", label: "쇼핑몰 설정", desc: "쇼핑몰 · 배송비 · 법정 고지 · 알림" },
];
const OWNER_ONLY = ["결제(PG) 연결", "구독 · 결제", "직원 관리", "적립금 실지급"];
// 묶음: 누른 뒤 개별로 고칠 수 있다
const BUNDLES: { label: string; perms: StaffPerm[] }[] = [
  { label: "방송만", perms: ["BROADCAST_RUN", "OVERLAY_EDIT"] },
  { label: "운영 전체", perms: PERMS.map((p) => p.key) },
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

export const MIN_PASSWORD_LENGTH = 8; // 서버(lib/server/auth/passwordReset.ts)와 같은 값
// 서버(normalizeStaffPhone)와 같은 규칙: 띄어쓰기·하이픈을 빼고 01로 시작하는 10~11자리
export const cleanPhone = (v: string) => v.normalize("NFKC").replace(/[ -]/g, "");
export const phoneOk = (v: string) => /^01\d{8,9}$/.test(cleanPhone(v));

// 서버 실패 이유 → 화면 문구(서버가 문구를 주지 않는 응답)
export const STAFF_ERRORS: Record<string, string> = {
  email_taken: "이미 쓰고 있는 이메일이에요",
  weak_password: `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`,
  invalid_phone: "휴대폰 번호를 다시 확인해 주세요",
  invalid_permissions: "권한을 다시 골라 주세요",
  bad_request: "입력한 내용을 다시 확인해 주세요",
};
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
        <span className="t-c1 c-alt">누른 뒤 개별로 고칠 수 있어요</span>
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
              <span className="t-c1 c-alt">대표자만 할 수 있어요</span>
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

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

// 직원 정보·권한 수정: 이름·휴대폰은 PATCH, 권한은 permissions로 보낸다(바뀐 것만)
export function EditStaffModal({ staff, onClose, onSaved }: { staff: Staff; onClose: () => void; onSaved: (text: string) => void }) {
  const [name, setName] = useState(staff.name);
  const [phone, setPhone] = useState(staff.phone ?? "");
  const [perms, setPerms] = useState<StaffPerm[]>(staff.permissions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const nextPhone = phone.trim() === "" ? null : cleanPhone(phone);
  const phoneChanged = nextPhone !== staff.phone;
  const profileChanged = name.trim() !== staff.name || phoneChanged;
  const permsChanged = !sameSet(perms, staff.permissions);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!name.trim()) return setError("이름을 적어 주세요");
    if (nextPhone !== null && !phoneOk(phone)) return setPhoneError("01로 시작하는 휴대폰 번호를 숫자로 적어 주세요");
    setBusy(true);
    setError(null);
    setPhoneError(null);
    if (profileChanged) {
      const r = await api(`/api/seller/staff/${staff.id}`, { method: "PATCH", body: { name: name.trim(), phone: nextPhone } });
      if (!r.ok) {
        setBusy(false);
        if (r.error === "invalid_phone") return setPhoneError(STAFF_ERRORS.invalid_phone);
        return setError(staffFail(r, "저장하지 못했어요. 잠시 뒤 다시 시도해 주세요"));
      }
    }
    if (permsChanged) {
      const r = await api(`/api/seller/staff/${staff.id}/permissions`, { method: "POST", body: { permissions: perms } });
      if (!r.ok) {
        setBusy(false);
        return setError(profileChanged ? `이름·휴대폰은 저장했지만 권한은 바꾸지 못했어요. ${staffFail(r, "다시 시도해 주세요")}` : staffFail(r, "저장하지 못했어요. 잠시 뒤 다시 시도해 주세요"));
      }
    }
    setBusy(false);
    onSaved(phoneChanged && staff.identityLinked ? `${name.trim()} 정보를 저장했어요 · 다음 로그인 때 본인확인을 다시 안내해요` : `${name.trim()} 정보를 저장했어요`);
  };

  return (
    <Dialog title={`${staff.name} 정보 · 권한 수정`} labelId="staff-edit-title" busy={busy} onClose={onClose} wide>
      <form className="col" style={{ gap: 14 }} onSubmit={save} noValidate>
        <p className="t-b2 c-neu" style={{ margin: 0 }}>
          {staff.email}
        </p>
        {error && (
          <div className="msg msg-neg" role="alert">
            <span>{error}</span>
          </div>
        )}
        <div className="pa-two">
          <div className="fld">
            <label htmlFor="se-name">이름</label>
            <input id="se-name" className="inp" maxLength={50} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="fld">
            <label htmlFor="se-phone">휴대폰 번호</label>
            <input
              id="se-phone"
              className={`inp num${phoneError ? " is-error" : ""}`}
              inputMode="numeric"
              placeholder="숫자만 입력"
              value={phone}
              disabled={busy}
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
            <b>번호를 바꾸면 직원이 다시 본인확인을 해야 해요.</b> 저장하면 연결만 풀려요. 다시 연결하기 전까지는 아이디 · 비밀번호를 스스로 찾을 수 없고, 다른 메뉴는 그대로 써요.
          </div>
        ) : (
          <span className="t-c1 c-alt">
            {staff.phone === null ? "예전에 만든 직원은 비어 있어요 · 채우면 직원이 다음 로그인 때 휴대폰 본인확인으로 계정을 연결해요" : "직원이 아이디 · 비밀번호를 찾을 때 본인확인에 써요"}
          </span>
        )}
        <div className="row between staff-link">
          <span className="t-l1">계정 연결</span>
          <span className={`bdg ${staff.identityLinked && !phoneChanged ? "b-done" : "b-cancel"}`}>{staff.identityLinked && !phoneChanged ? "연결됨" : "본인확인 전"}</span>
        </div>
        <PermissionPicker value={perms} onChange={setPerms} disabled={busy} />
        <span className="t-c1 c-alt">저장하면 바로 적용돼요 · 직원이 로그인 중이면 다음 화면부터 바뀌어요 · 변경 기록은 감사 로그에 남아요</span>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className={`btn${busy ? " is-loading" : ""}`} type="submit" disabled={busy || (!profileChanged && !permsChanged)}>
            {busy ? "저장하고 있어요" : "저장"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function ResetPasswordModal({ staff, onClose, onDone }: { staff: Staff; onClose: () => void; onDone: (text: string) => void }) {
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (pw.length < MIN_PASSWORD_LENGTH) return setError(`${MIN_PASSWORD_LENGTH}자 이상으로 정해 주세요`);
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/staff/${staff.id}/password`, { method: "POST", body: { newPassword: pw } });
    setBusy(false);
    if (r.ok) return onDone(`${staff.name} 비밀번호를 바꿨어요 · 직원에게 직접 알려 주세요`);
    setError(staffFail(r, "바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요"));
  };

  return (
    <Dialog title={`${staff.name}의 비밀번호를 새로 정할까요?`} labelId="staff-pw-title" busy={busy} onClose={onClose}>
      <form className="col" style={{ gap: 14 }} onSubmit={submit} noValidate>
        <div className="fld">
          <label htmlFor="sp-new">새 비밀번호</label>
          <input
            id="sp-new"
            className={`inp${error ? " is-error" : ""}`}
            type="text"
            autoComplete="off"
            maxLength={200}
            value={pw}
            disabled={busy}
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
              {MIN_PASSWORD_LENGTH}자 이상 · 직원에게 직접 전달해 주세요
            </span>
          )}
        </div>
        <span className="t-l2 c-neu">바꾸면 {staff.name}의 다른 기기 로그인은 모두 풀려요.</span>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className={`btn${busy ? " is-loading" : ""}`} type="submit" disabled={busy || pw === ""}>
            {busy ? "바꾸고 있어요" : "재설정"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function DisableStaffModal({ staff, onClose, onDone }: { staff: Staff; onClose: () => void; onDone: (text: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await api(`/api/seller/staff/${staff.id}/disable`, { method: "POST" });
    setBusy(false);
    if (r.ok) return onDone(`${staff.name} 계정을 비활성화했어요`);
    setError(failMessage(r, "비활성화하지 못했어요. 잠시 뒤 다시 시도해 주세요"));
  };

  return (
    <Dialog title={`${staff.name} 계정을 비활성화할까요?`} labelId="staff-disable-title" busy={busy} onClose={onClose}>
      <p className="t-b2 c-neu" style={{ margin: 0 }}>
        바로 로그아웃되고 다시 로그인할 수 없어요. 처리 기록은 감사 로그에 남아요.
      </p>
      {error && (
        <div className="msg msg-neg" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="modal-f">
        <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
          취소
        </button>
        <button className={`btn btn-neg${busy ? " is-loading" : ""}`} type="button" onClick={() => void submit()} disabled={busy}>
          {busy ? "비활성화하고 있어요" : "비활성화"}
        </button>
      </div>
    </Dialog>
  );
}
