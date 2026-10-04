"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { phoneText } from "../../../../../components/seller/IdentityCheck";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import {
  DisableStaffModal,
  EditStaffModal,
  MIN_PASSWORD_LENGTH,
  PERMS,
  PermissionPicker,
  ResetPasswordModal,
  SecretInput,
  STAFF_ERRORS,
  UnclearBox,
  cleanPhone,
  isUnclear,
  normStaffName,
  phoneOk,
  staffFail,
  staffNameError,
  type Staff,
  type StaffPerm,
} from "../../../../../components/seller/StaffForms";
import { ErrorState, Locked, LoadingRows, Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";

// SA-100 직원 계정(대표자 전용, 정본: docs/IA.md SA-100, 디자인 SA-100). 대표자가 직원 계정을 직접 만들고 권한을 항목별로 켜고 끈다.
// 직원을 만들 때 이름·휴대폰을 함께 받고(직원 아이디·비밀번호 찾기용), 예전 직원은 수정 창에서 채우거나 바꾼다.
// 번호를 바꾸면 직원 본인확인 연결이 풀려 직원이 다시 연결해야 한다.
// API: GET·POST /api/seller/staff, PATCH /api/seller/staff/{id}, POST …/{id}/permissions·password·disable.
// 다시 활성화·완전 삭제는 서버 기능이 아직 없어 두지 않는다.
type Modal = { kind: "edit" | "password" | "disable"; staff: Staff } | null;

const LABEL = Object.fromEntries(PERMS.map((p) => [p.key, p.label])) as Record<StaffPerm, string>;

// 마지막 로그인: 한국 시간 M/D HH:mm
function kstShort(iso: string | null): string {
  if (!iso) return "없음";
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${hh}:${mm}`;
}

export default function StaffPage() {
  const { me } = useSeller();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; staff: Staff[] }>({ kind: "loading" });
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState<string | null>(null);

  // 목록 다시 읽기가 겹치면(저장 직후·불분명 확인 등) 가장 마지막 요청의 응답만 반영한다
  const listSeq = useRef(0);
  const load = useCallback(async () => {
    const n = ++listSeq.current;
    const r = await api<{ staff: Staff[] }>("/api/seller/staff");
    if (n !== listSeq.current) return;
    // 이미 목록을 보여 주는 중에 다시 읽기만 실패하면 지금 화면을 그대로 둔다(직원 추가의 불분명 상태 등 입력 중인 내용을 잃지 않게)
    if (!r.ok) return setState((prev) => (prev.kind === "ok" ? prev : { kind: "error", status: r.status }));
    setState({ kind: "ok", staff: r.data.staff });
  }, []);

  useEffect(() => {
    if (me.isOwner) void load();
  }, [me.isOwner, load]);

  const done = (text: string) => {
    setModal(null);
    setToast(text);
    void load();
  };

  const staff = state.kind === "ok" ? state.staff : [];
  const active = staff.filter((s) => s.status === "ACTIVE").length;

  return (
    <>
      <Topbar crumb="설정 › 직원 계정" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">
              직원 계정{" "}
              {state.kind === "ok" && (
                <span className="c-alt fw5" data-testid="staff-count">
                  {active}명
                </span>
              )}
            </h1>
            <span className="t-l2 c-alt">대표자가 직접 계정을 만들고 권한을 항목별로 설정합니다. 직원은 파트너스 로그인으로 접속해 허용된 메뉴만 사용합니다.</span>
          </div>
        </div>

        {!me.isOwner ? (
          <div className="card">
            <div className="st" style={{ boxShadow: "none" }}>
              <span className="t">대표자만 볼 수 있습니다</span>
              <span className="s">직원 계정은 대표자가 만들고 관리합니다. 필요한 사항은 대표자에게 요청해 주십시오</span>
            </div>
          </div>
        ) : state.kind !== "ok" ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={3} />}
            {state.kind === "error" && (state.status === 402 ? <Locked /> : <ErrorState title="직원 목록을 불러오지 못했습니다" onRetry={() => void load()} />)}
          </div>
        ) : (
          <div className="staff-grid">
            <div className="col" style={{ gap: 16, minWidth: 0 }}>
              <div className="card staff-table-wrap">
                <table className="tbl staff-table">
                  <thead>
                    <tr>
                      <th>이름 · 이메일</th>
                      <th>켜진 권한</th>
                      <th>상태</th>
                      <th>마지막 로그인</th>
                      <th aria-label="관리" />
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>
                        <span className="fw6">{me.user.name} (나)</span>
                        <div className="t-c1 c-alt">{me.user.email}</div>
                      </td>
                      <td>
                        <span className="bdg b-open nodot">대표자 · 모든 권한</span>
                      </td>
                      <td>
                        <span className="bdg b-done">활성</span>
                      </td>
                      <td className="num t-l2">지금</td>
                      <td />
                    </tr>
                    {staff.map((s) => {
                      const off = s.status !== "ACTIVE";
                      return (
                        <tr key={s.id} className={off ? "faded" : undefined} data-testid="staff-row">
                          <td>
                            <span className="fw6">{s.name}</span>
                            <div className="t-c1 c-alt">{s.email}</div>
                            <div className="t-c1 c-alt">
                              {s.phone ? phoneText(s.phone) : "휴대폰 미등록"} · {s.identityLinked ? "본인확인 연결됨" : "본인확인 전"}
                            </div>
                          </td>
                          <td>
                            <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                              {s.permissions.length === 0 ? (
                                <span className="t-c1 c-alt">켜진 권한 없음</span>
                              ) : (
                                s.permissions.map((p) => (
                                  <span key={p} className="bdg b-info nodot">
                                    {LABEL[p] ?? p}
                                  </span>
                                ))
                              )}
                            </div>
                          </td>
                          <td>
                            <span className={`bdg ${off ? "b-cancel" : "b-done"}`}>{off ? "비활성" : "활성"}</span>
                          </td>
                          <td className="num t-l2">{kstShort(s.lastLoginAt)}</td>
                          <td>
                            {!off && (
                              <div className="col" style={{ gap: 4, alignItems: "flex-start" }}>
                                <div className="row" style={{ gap: 4 }}>
                                  <button className="btn btn-sm btn-out" type="button" onClick={() => setModal({ kind: "edit", staff: s })} aria-label={`${s.name} 정보 · 권한 수정`}>
                                    수정
                                  </button>
                                  <button className="icon-btn staff-x" type="button" onClick={() => setModal({ kind: "disable", staff: s })} aria-label={`${s.name} 비활성화`}>
                                    ×
                                  </button>
                                </div>
                                <button className="btn btn-sm btn-text" type="button" style={{ paddingLeft: 0 }} onClick={() => setModal({ kind: "password", staff: s })} aria-label={`${s.name} 비밀번호 재설정`}>
                                  비밀번호 재설정
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {staff.length === 0 && (
                  <div className="st" style={{ boxShadow: "none" }}>
                    <span className="t">등록된 직원이 없습니다</span>
                    <span className="s">방송 보조가 필요하면 직원을 추가해 주십시오</span>
                  </div>
                )}
              </div>
              <div className="card pad col" style={{ gap: 6 }}>
                <span className="t-hl2">안내</span>
                <span className="t-l2 c-neu">결제(PG) 연결 · 구독 · 직원 관리 · 적립금 실지급은 대표자만 할 수 있습니다. 직원에게는 메뉴가 표시되지 않습니다.</span>
                <span className="t-l2 c-neu">권한 변경은 즉시 적용됩니다. 직원이 로그인 중이면 다음 화면부터 반영됩니다. 변경 기록은 로그 추적에 남습니다.</span>
              </div>
            </div>
            <AddStaff onAdded={(name) => done(`${name} 계정을 생성했습니다 · 이메일과 초기 비밀번호를 직원에게 직접 전달해 주십시오`)} onChanged={() => void load()} />
          </div>
        )}
      </main>
      {modal?.kind === "edit" && <EditStaffModal staff={modal.staff} onClose={() => setModal(null)} onSaved={done} onChanged={() => void load()} />}
      {modal?.kind === "password" && <ResetPasswordModal staff={modal.staff} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === "disable" && <DisableStaffModal staff={modal.staff} onClose={() => setModal(null)} onDone={done} onChanged={() => void load()} />}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

const UNCLEAR_CREATE = "생성 여부를 확인하지 못했습니다. 목록에서 확인하고, 있으면 비밀번호를 재설정해 주십시오. 같은 값으로 재전송해 성공하면 생성이 확정됩니다";
const TAKEN_TEXT = "이 이메일로 등록된 계정이 이미 있습니다. 목록에서 확인하고 필요하면 비밀번호를 재설정해 주십시오";

type Errors = Partial<Record<"name" | "phone" | "email" | "password", string>>;

// 직원 추가: 이름·휴대폰·이메일(로그인 아이디)·초기 비밀번호·권한. 메일 초대 없이 바로 계정이 만들어진다
function AddStaff({ onAdded, onChanged }: { onAdded: (name: string) => void; onChanged: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [perms, setPerms] = useState<StaffPerm[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 결과가 불분명했던 시도(보낸 값 그대로, 비밀번호 포함). 있는 동안 칸을 잠그고 「같은 값으로 재전송」과 「새로 입력」만 누를 수 있다.
  // 목록으로 「생성됨」을 추정하지 않는다: 목록의 계정이 이 요청으로 생긴 것인지(다른 창이 만든 것인지), 입력한 비밀번호가 적용됐는지 알 수 없기 때문.
  // 생성을 확정하는 것은 서버의 성공 응답뿐이다(재전송 포함). 목록은 보여 주기용으로만 다시 읽는다
  type Sent = { name: string; body: { name: string; phone: string; email: string; password: string; permissions: StaffPerm[] } };
  const [unclear, setUnclear] = useState<Sent | null>(null);
  // 불분명했던 시도를 두고 「새로 입력」으로 나왔을 때의 안내
  const [notice, setNotice] = useState<string | null>(null);
  // 불분명했던 시도를 두고 새로 시작했는지. 그 뒤 email_taken은 만든 것으로 보지 않고 안내한다
  const [restarted, setRestarted] = useState(false);
  const locked = busy || unclear !== null;
  // 보내는 동안 칸이 잠겨 있으므로 다시 그린 뒤에 포커스를 옮긴다
  const [focusTo, setFocusTo] = useState<{ id: string } | null>(null);
  useEffect(() => {
    if (!focusTo) return;
    document.getElementById(focusTo.id)?.focus();
    setFocusTo(null);
  }, [focusTo]);

  const succeed = (added: string) => {
    setBusy(false);
    setUnclear(null);
    setNotice(null);
    setRestarted(false);
    setName("");
    setPhone("");
    setEmail("");
    setPassword("");
    setPerms([]);
    onAdded(added);
  };

  // 불분명한 상태로 둔다(목록은 보여 주기용으로 다시 읽음)
  const keepUnclear = (sent: Sent, text: string) => {
    setBusy(false);
    setUnclear(sent);
    setFailure(text);
    onChanged();
  };

  // 보낸 값 그대로 다시 보낸다. 성공 응답이면 생성 확정. email_taken이면 이전 요청이 만들었는지 다른 계정인지 알 수 없어 불분명으로 남긴다
  const resend = async (sent: Sent) => {
    setBusy(true);
    setFailure(null);
    const r = await api("/api/seller/staff", { method: "POST", body: sent.body });
    if (r.ok) return succeed(sent.name);
    if (isUnclear(r)) return keepUnclear(sent, UNCLEAR_CREATE);
    if (r.error === "email_taken") return keepUnclear(sent, "같은 이메일의 계정이 이미 있습니다. 이전 요청으로 생성된 계정인지는 확인할 수 없습니다. 목록에서 확인하고, 있으면 비밀번호를 재설정해 주십시오");
    keepUnclear(sent, staffFail(r, "재전송하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
  };

  const restart = () => {
    setUnclear(null);
    setRestarted(true);
    setFailure(null);
    setNotice("이전 계정 생성 요청이 처리되었을 수 있습니다. 목록에서 확인한 뒤 입력해 주십시오");
    onChanged();
    setFocusTo({ id: "sa-name" });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (locked) return;
    const next: Errors = {};
    const nameError = staffNameError(name);
    if (nameError) next.name = nameError;
    if (!phoneOk(phone)) next.phone = "01로 시작하는 휴대폰 번호를 숫자로 입력해 주십시오";
    if (!email.trim().includes("@")) next.email = "로그인에 사용할 이메일을 입력해 주십시오";
    if (password.length < MIN_PASSWORD_LENGTH) next.password = `${MIN_PASSWORD_LENGTH}자 이상으로 정해 주십시오`;
    setErrors(next);
    setFailure(null);
    const first = (["name", "phone", "email", "password"] as const).find((k) => next[k]);
    if (first) return setFocusTo({ id: `sa-${first}` });
    setBusy(true);
    setNotice(null);
    const body = { name: name.trim(), phone: cleanPhone(phone), email: email.trim(), password, permissions: perms };
    const sent: Sent = { name: normStaffName(name), body };
    const r = await api("/api/seller/staff", { method: "POST", body });
    if (r.ok) return succeed(sent.name);
    // 결과가 불분명하면(연결 끊김·5xx·코드 없는 응답) 성공도 실패도 단정하지 않는다
    if (isUnclear(r)) return keepUnclear(sent, UNCLEAR_CREATE);
    setBusy(false);
    if (r.error === "email_taken" && restarted) {
      onChanged();
      setErrors({ email: TAKEN_TEXT });
      return setFocusTo({ id: "sa-email" });
    }
    const field = ({ email_taken: "email", weak_password: "password", invalid_phone: "phone" } as const)[r.error as "email_taken"];
    if (field) {
      setErrors({ [field]: STAFF_ERRORS[r.error] });
      return setFocusTo({ id: `sa-${field}` });
    }
    setFailure(staffFail(r, "계정을 생성하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
  };

  const field = (key: keyof Errors, label: string, input: React.ReactNode, help?: string) => (
    <div className="fld">
      <label htmlFor={`sa-${key}`} className="req">
        {label}
      </label>
      {input}
      {errors[key] ? (
        <span id={`sa-${key}-err`} className="err" role="alert">
          {errors[key]}
        </span>
      ) : (
        help && <span className="help">{help}</span>
      )}
    </div>
  );
  const inputProps = (key: keyof Errors) => ({
    id: `sa-${key}`,
    className: `inp${errors[key] ? " is-error" : ""}`,
    disabled: locked,
    "aria-invalid": !!errors[key],
    "aria-describedby": errors[key] ? `sa-${key}-err` : undefined,
  });

  return (
    <form className="card pad-l col staff-add" style={{ gap: 14 }} onSubmit={submit} noValidate aria-labelledby="sa-title">
      <div className="col" style={{ gap: 2 }}>
        <h2 className="t-hl1" id="sa-title">
          직원 추가
        </h2>
        <span className="t-c1 c-alt">계정이 즉시 생성됩니다 · 메일 초대는 없습니다</span>
      </div>
      {unclear ? (
        <UnclearBox
          testId="sa-unclear"
          title="계정이 생성되었을 수 있습니다."
          text={failure ?? UNCLEAR_CREATE}
          busy={busy}
          onResend={() => void resend(unclear)}
          resendLabel="같은 값으로 재전송"
          extra={
            <button className="btn btn-sm btn-text" type="button" disabled={busy} onClick={restart}>
              새로 입력
            </button>
          }
        />
      ) : failure ? (
        <div className="msg msg-neg" role="alert">
          <span>{failure}</span>
        </div>
      ) : (
        notice && (
          <div className="msg msg-cau" role="status" data-testid="sa-notice">
            <span>{notice}</span>
          </div>
        )
      )}
      {field("name", "이름", <input {...inputProps("name")} value={name} onChange={(e) => setName(e.target.value)} />)}
      {field(
        "phone",
        "휴대폰 번호",
        <input {...inputProps("phone")} className={`${inputProps("phone").className} num`} inputMode="numeric" placeholder="숫자만 입력" value={phone} onChange={(e) => setPhone(e.target.value)} />,
        "직원이 아이디 · 비밀번호를 찾을 때 본인확인에 사용합니다",
      )}
      {field(
        "email",
        "이메일 (로그인 아이디)",
        <input {...inputProps("email")} type="text" inputMode="email" autoCapitalize="none" spellCheck={false} autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} />,
      )}
      {field(
        "password",
        "초기 비밀번호",
        <SecretInput {...inputProps("password")} maxLength={200} value={password} onChange={(e) => setPassword(e.target.value)} />,
        `${MIN_PASSWORD_LENGTH}자 이상 · 직원에게 직접 전달해 주십시오`,
      )}
      <PermissionPicker value={perms} onChange={setPerms} disabled={locked} />
      <button className={`btn btn-lg btn-block${busy ? " is-loading" : ""}`} type="submit" disabled={locked}>
        {busy ? "생성 중" : "계정 생성"}
      </button>
    </form>
  );
}
