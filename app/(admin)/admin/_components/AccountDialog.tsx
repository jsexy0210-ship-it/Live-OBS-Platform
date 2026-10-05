"use client";

import { useState } from "react";
import { Modal } from "../../../../components/admin-ui/Modal";
import { adminApi } from "./api";
import { ASSIGNABLE_ROLES, MIN_PASSWORD, ROLE_LABEL, type AdminAccount, type AdminRoleCode, type AdminStatus } from "./accounts";

// 관리자 계정 추가·수정 창(MA-062). 수정에서 최고관리자 계정은 이름만 바꿀 수 있어 역할·상태 칸을 아예 그리지 않는다.
// 처리 중에는 닫기·취소를 막는다. 서버가 거절하면 이유를 안내한다.
const ERROR: Record<string, string> = {
  invalid_input: "입력한 내용을 확인해 주십시오.",
  weak_password: `비밀번호는 ${MIN_PASSWORD}자 이상 입력해 주십시오.`,
  email_taken: "이미 사용 중인 이메일입니다.",
  super_admin_protected: "최고관리자의 역할과 상태는 바꿀 수 없습니다.",
  super_admin_not_assignable: "최고관리자 역할은 줄 수 없습니다.",
  not_found: "계정을 찾을 수 없습니다. 목록을 새로 불러와 주십시오.",
};

export function AccountDialog({ account, onClose, onDone }: { account: AdminAccount | null; onClose: () => void; onDone: (saved: AdminAccount, created: boolean) => void }) {
  const editing = account !== null;
  const protectedAccount = account?.role === "SUPER_ADMIN";
  const [email, setEmail] = useState("");
  const [name, setName] = useState(account?.name ?? "");
  const [role, setRole] = useState<AdminRoleCode>(account && !protectedAccount ? account.role : "READ_ONLY");
  const [status, setStatus] = useState<AdminStatus>(account?.status ?? "ACTIVE");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = editing
    ? name !== account.name || (!protectedAccount && (role !== account.role || status !== account.status))
    : email !== "" || name !== "" || password !== "" || role !== "READ_ONLY";
  const ready = name.trim() !== "" && name.trim().length <= 50 && (editing || (email.trim() !== "" && password.length >= MIN_PASSWORD));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const r = editing
      ? await adminApi<{ admin: AdminAccount }>(`/api/admin/admins/${account.id}`, {
          method: "PATCH",
          json: {
            ...(name.trim() !== account.name ? { name: name.trim() } : {}),
            ...(!protectedAccount && role !== account.role ? { role } : {}),
            ...(!protectedAccount && status !== account.status ? { status } : {}),
          },
        })
      : await adminApi<{ admin: AdminAccount }>("/api/admin/admins", { method: "POST", json: { email: email.trim(), name: name.trim(), role, password } });
    setBusy(false);
    if (r.ok) return onDone(r.data.admin, !editing);
    setError(ERROR[r.error] ?? (r.status === 403 ? "최고관리자만 할 수 있습니다." : r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오." : "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };

  return (
    <Modal labelId="account-title" busy={busy} dirty={dirty} onClose={onClose}>
      {(requestClose) => (
      <form className="col" style={{ gap: 16 }} onSubmit={submit} noValidate>
        <div className="modal-h">
          <h2 className="modal-t" id="account-title">
            {editing ? "관리자 계정 수정" : "관리자 계정 추가"}
          </h2>
        </div>
        <div className="col" style={{ gap: 14, }}>
          {!editing && (
            <div className="fld">
              <label htmlFor="account-email">이메일</label>
              <input id="account-email" className="inp" type="text" inputMode="email" autoCapitalize="none" spellCheck={false} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
            </div>
          )}
          {editing && (
            <div className="fld">
              <span className="lbl">이메일</span>
              <span>{account.email}</span>
            </div>
          )}
          <div className="fld">
            <label htmlFor="account-name">이름</label>
            <input id="account-name" className="inp" type="text" maxLength={50} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </div>
          {protectedAccount ? (
            <div className="fld">
              <span className="lbl">역할</span>
              <span>{ROLE_LABEL.SUPER_ADMIN}</span>
              <span className="t-c1 c-alt">최고관리자의 역할과 상태는 바꿀 수 없습니다.</span>
            </div>
          ) : (
            <div className="fld">
              <label htmlFor="account-role">역할</label>
              <select id="account-role" className="inp" value={role} onChange={(e) => setRole(e.target.value as AdminRoleCode)} disabled={busy}>
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </select>
            </div>
          )}
          {editing && !protectedAccount && (
            <div className="fld">
              <label htmlFor="account-status">상태</label>
              <select id="account-status" className="inp" value={status} onChange={(e) => setStatus(e.target.value as AdminStatus)} disabled={busy}>
                <option value="ACTIVE">이용 중</option>
                <option value="SUSPENDED">정지</option>
              </select>
              {status === "SUSPENDED" && <span className="t-c1 c-alt">정지하면 이 계정의 로그인이 바로 끝납니다.</span>}
            </div>
          )}
          {!editing && (
            <div className="fld">
              <label htmlFor="account-password">처음 비밀번호</label>
              <input id="account-password" className="inp" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
              <span className="t-c1 c-alt">{MIN_PASSWORD}자 이상. 계정을 받는 분께 따로 전달해 주십시오.</span>
            </div>
          )}
          {error && (
            <span className="err" role="alert">
              {error}
            </span>
          )}
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
            취소
          </button>
          <button className="btn" type="submit" disabled={!ready || busy}>
            {busy ? "저장 중" : editing ? "저장" : "추가"}
          </button>
        </div>
      </form>
      )}
    </Modal>
  );
}
