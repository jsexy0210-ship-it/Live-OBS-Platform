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
  UNCLEAR_PENDING,
  UNCLEAR_UNREAD,
  UnclearBox,
  cleanPhone,
  isUnclear,
  normStaffName,
  phoneOk,
  readStaffList,
  settleByList,
  sameSet,
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
    if (!r.ok) return setState({ kind: "error", status: r.status });
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
            <AddStaff onAdded={(name) => done(`${name} 계정을 생성했습니다 · 이메일과 초기 비밀번호를 직원에게 직접 전달해 주십시오`)} onChanged={() => void load()} knownIds={staff.map((s) => s.id)} />
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

const TAKEN_TEXT = "이 이메일로 등록된 계정이 이미 있습니다. 목록에서 확인하고 필요하면 비밀번호를 재설정해 주십시오";

type Errors = Partial<Record<"name" | "phone" | "email" | "password", string>>;

// 직원 추가: 이름·휴대폰·이메일(로그인 아이디)·초기 비밀번호·권한. 메일 초대 없이 바로 계정이 만들어진다
function AddStaff({ onAdded, onChanged, knownIds }: { onAdded: (name: string) => void; onChanged: () => void; knownIds: string[] }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [perms, setPerms] = useState<StaffPerm[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 결과가 불분명했던 시도(보낸 값 그대로). 있는 동안 칸을 잠그고 「확인」(목록을 다시 읽음)과 「같은 값으로 재전송」만 누를 수 있다:
  // 첫 요청이 아직 서버에서 처리 중일 수 있어, 목록에 없다고 실패로 확정하지 않는다. 다른 값으로 보내면 서버에 남은 계정(첫 비밀번호)과 화면 값이 달라진다
  // check: 목록에서 확인할 값(이름·휴대폰은 서버가 저장하는 모양). before: 보내기 직전의 직원 id(이미 있던 계정—비활성 포함—을 방금 만든 계정으로 오인하지 않게)
  // body: 재전송할 본문 그대로(비밀번호 포함)
  type Sent = { check: { name: string; phone: string; email: string; perms: StaffPerm[] }; before: string[]; body: { name: string; phone: string; email: string; password: string; permissions: StaffPerm[] } };
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

  // 그 시도가 만들어졌는지 목록으로 확인한다: 보내기 전에 없던 id이고 활성이며 같은 이메일·이름·휴대폰·권한이면 만든 것. null은 목록을 읽지 못함
  const createdIn = (sent: Sent) =>
    settleByList((list) =>
      list.some(
        (s) =>
          !sent.before.includes(s.id) &&
          s.status === "ACTIVE" &&
          s.email.toLowerCase() === sent.check.email.toLowerCase() &&
          s.name === sent.check.name &&
          s.phone === sent.check.phone &&
          sameSet(s.permissions, sent.check.perms),
      ),
    );

  // 확실한 성공 증거(목록의 새 계정)가 있을 때만 풀고, 없으면 불분명한 채로 둔다
  const confirmSent = async (sent: Sent) => {
    setBusy(true);
    setFailure(null);
    const created = await createdIn(sent);
    if (created) return succeed(sent.check.name);
    setBusy(false);
    setUnclear(sent);
    setFailure(created === null ? UNCLEAR_UNREAD : UNCLEAR_PENDING);
  };

  // 보낸 값 그대로 다시 보낸다. 성공 응답이면 만든 것. email_taken이면 첫 시도가 만들었을 수 있어 목록으로 확인하고,
  // 새 계정이 없으면 이미 있던 다른 계정이 이메일을 쓰고 있는 것이므로(첫 시도도 만들 수 없었음) 불분명을 끝내고 안내한다
  const resend = async (sent: Sent) => {
    setBusy(true);
    setFailure(null);
    const r = await api("/api/seller/staff", { method: "POST", body: sent.body });
    if (r.ok) return succeed(sent.check.name);
    if (isUnclear(r)) return confirmSent(sent);
    if (r.error === "email_taken") {
      const created = await createdIn(sent);
      if (created) return succeed(sent.check.name);
      if (created === null) {
        setBusy(false);
        return setFailure(UNCLEAR_UNREAD);
      }
      setBusy(false);
      setUnclear(null);
      onChanged();
      setErrors({ email: TAKEN_TEXT });
      return setFocusTo({ id: "sa-email" });
    }
    setBusy(false);
    setFailure(staffFail(r, "재전송하지 못했습니다. 잠시 후 「확인」을 눌러 주십시오"));
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
    // 보내기 직전의 직원 id를 남긴다(읽지 못하면 화면에 있는 목록으로)
    const before = (await readStaffList())?.map((s) => s.id) ?? knownIds;
    const body = { name: name.trim(), phone: cleanPhone(phone), email: email.trim(), password, permissions: perms };
    const sent: Sent = { check: { name: normStaffName(name), phone: body.phone, email: body.email, perms }, before, body };
    const r = await api("/api/seller/staff", { method: "POST", body });
    if (r.ok) return succeed(sent.check.name);
    // 결과가 불분명하면(연결 끊김·5xx) 실패라고 하지 않고 이 시도가 만들어졌는지 확인한다
    if (isUnclear(r)) return confirmSent(sent);
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
          text={failure ?? UNCLEAR_PENDING}
          busy={busy}
          onCheck={() => void confirmSent(unclear)}
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
