"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { formatDateTime } from "../../../../../../lib/client/format";
import { FormFoot, FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi, failMessage } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";

// MA-088 플랫폼 정보(GET·PUT /api/admin/settings/platform-business). 정본: design/project/MA-088.dc.html(FINAL v324).
// 쇼핑몰 바닥글·주문서·메일에 플랫폼(호스팅 제공자)으로 표시되는 전자상거래법 표시 의무 7항목. 보기는 마스터 관리자 전 역할, 수정은 최고관리자만(system.manage).
// 사업자등록번호는 화면에서 숫자 10자리로 받고 서버에는 000-00-00000 형식으로 보낸다. 변경 이력은 로그 추적(audit.read 권한이 있을 때만)에서 가져온다.
// 로그 추적에는 바뀐 칸 이름만 남는다(값은 남기지 않음, #846 결정). 7칸이 모두 있어야 저장할 수 있다(정본 「모두 필수」).
type Info = { name: string; representative: string; businessNumber: string; mailOrderNumber: string; address: string; phone: string; email: string; complete: boolean; updatedAt: string | null };
type Key = "name" | "representative" | "businessNumber" | "mailOrderNumber" | "address" | "phone" | "email";
type Form = Record<Key, string>;
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; info: Info };
type History = { id: string; at: string; fields: string[]; actor: string };

const ROWS: { key: Key; label: string; cls: string; placeholder?: string; help?: string; empty: string }[] = [
  { key: "name", label: "상호", cls: "w-l", help: "사업자등록증의 상호 그대로", empty: "상호를 입력해 주십시오" },
  { key: "representative", label: "대표자", cls: "w-m", empty: "대표자를 입력해 주십시오" },
  { key: "businessNumber", label: "사업자등록번호", cls: "w-m", placeholder: "숫자 10자리", help: "하이픈 없이", empty: "사업자등록번호는 숫자 10자리로 입력해 주십시오" },
  { key: "mailOrderNumber", label: "통신판매업 신고번호", cls: "w-l", placeholder: "예: 제2026-서울강남-01234호", empty: "통신판매업 신고번호를 입력해 주십시오" },
  { key: "address", label: "사업장 주소", cls: "w-xl", help: "우편번호 · 기본 주소 · 상세 주소를 한 줄로", empty: "사업장 주소를 입력해 주십시오" },
  { key: "phone", label: "고객센터 전화", cls: "w-m", placeholder: "예: 1588-0000", help: "구매자 화면 바닥글과 메일에 표시", empty: "고객센터 전화를 입력해 주십시오" },
  { key: "email", label: "고객센터 이메일", cls: "w-l", placeholder: "example@email.com", help: "구매자 · 파트너스 문의 회신 주소", empty: "이메일 형식을 확인해 주십시오" },
];
const WIDTH: Record<string, number> = { "w-l": 320, "w-m": 184, "w-xl": 520 };
const LABEL = Object.fromEntries(ROWS.map((r) => [r.key, r.label])) as Record<Key, string>;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digits = (v: string) => v.replace(/\D/g, "");
const dash = (d: string) => `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
// 서버 값 → 화면 값(사업자등록번호는 하이픈 없이)
const toForm = (i: Info): Form => ({ ...i, businessNumber: digits(i.businessNumber) });

export default function PlatformBusinessPage() {
  const { me } = useAdmin();
  const { confirm } = useConfirm();
  const canEdit = adminCan(me.role, "system.manage");
  const canAudit = adminCan(me.role, "audit.read");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const [history, setHistory] = useState<History[] | null>(null);

  const loadHistory = useCallback(async () => {
    if (!canAudit) return;
    const r = await adminApi<{ logs: { id: string; createdAt: string }[] }>("/api/admin/audit-logs?action=platform.business_info.update&limit=5");
    if (!r.ok) return setHistory([]);
    const rows = await Promise.all(
      r.data.logs.map(async (l) => {
        const d = await adminApi<{ log: { after: { fields?: string[] } | null; actorAdmin: { name: string } | null } }>(`/api/admin/audit-logs/${l.id}`);
        const log = d.ok ? d.data.log : null;
        return { id: l.id, at: l.createdAt, fields: log?.after?.fields ?? [], actor: log?.actorAdmin?.name ?? "—" };
      }),
    );
    setHistory(rows);
  }, [canAudit]);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<Info>("/api/admin/settings/platform-business");
    if (!r.ok) return setState({ kind: "error" });
    setState({ kind: "ok", info: r.data });
    setForm(toForm(r.data));
    setErrors({});
  }, []);
  useEffect(() => {
    void load();
    void loadHistory();
  }, [load, loadHistory]);

  const info = state.kind === "ok" ? state.info : null;
  const saved = info ? toForm(info) : null;
  const changed = info && form && saved ? ROWS.filter((r) => form[r.key].trim() !== saved[r.key]).map((r) => r.key) : [];

  const validate = (f: Form) => {
    const e: Partial<Record<Key, string>> = {};
    for (const r of ROWS) {
      const v = f[r.key].trim();
      if (r.key === "businessNumber" ? digits(v).length !== 10 : r.key === "email" ? !EMAIL.test(v) : v === "") e[r.key] = r.empty;
    }
    return e;
  };

  const save = async () => {
    if (!form || !saved) return;
    const e = validate(form);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const body: Partial<Record<Key, string>> = {};
    for (const k of changed) body[k] = k === "businessNumber" ? dash(digits(form[k])) : form[k].trim();
    const ok = await confirm({
      title: "플랫폼 정보를 저장하시겠습니까?",
      body: `${changed.map((k) => LABEL[k]).join(" · ")} 항목이 바뀝니다 · 바뀐 값은 저장 즉시 쇼핑몰 바닥글 · 주문서 · 메일에 반영됩니다. 변경은 로그 추적에 남습니다.`,
      confirmLabel: "저장",
      run: async () => {
        const r = await adminApi<{ info: Info }>("/api/admin/settings/platform-business", { method: "PUT", json: body });
        if (r.ok) return;
        return failMessage(r, "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오.");
      },
    });
    if (!ok) return;
    setToast({ text: "플랫폼 정보를 저장했습니다 · 로그 추적에 남겼습니다" });
    await load();
    void loadHistory();
  };

  return (
    <>
      <AdminTopbar crumb="설정 › 플랫폼 정보" />
      <main className="main">
        <PageHead title="플랫폼 정보" />
        <div className="col" style={{ gap: 20 }}>
          <div className="msg msg-info" role="note">
            <span>
              <b>쇼핑몰 바닥글 · 주문서 · 메일에 플랫폼(호스팅 제공자)으로 표시되는 값입니다.</b> 수정은 최고관리자만 할 수 있고 변경은 로그 추적에 남습니다 · 한 항목이라도 비어 있으면 홈 「오늘 처리할 일」에 「플랫폼 정보 미입력」이 표시됩니다
            </span>
          </div>
          {!canEdit && (
            <div className="msg msg-info" role="status">
              <span>플랫폼 정보는 최고관리자만 수정할 수 있습니다 · 값은 읽기 전용으로 보이고 「저장」 버튼은 보이지 않습니다</span>
            </div>
          )}
          {state.kind === "loading" && (
            <div className="card">
              <LoadingRows rows={5} />
            </div>
          )}
          {state.kind === "error" && (
            <div className="card">
              <ErrorState title="플랫폼 정보를 불러오지 못했습니다." onRetry={() => void load()} />
            </div>
          )}
          {state.kind === "ok" && form && (
            <>
              <form
                id="pb-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canEdit && changed.length > 0) void save();
                }}
              >
                <FormSection title="기본 정보" actions={<span className="t-c1 c-alt">전자상거래법 표시 의무 항목 · 모두 필수</span>}>
                  {ROWS.map((r) => (
                    <FormRow key={r.key} label={r.label} required={canEdit} htmlFor={`pb-${r.key}`} help={errors[r.key] ? undefined : r.help}>
                      {canEdit ? (
                        <>
                          <input
                            id={`pb-${r.key}`}
                            className={`inp${errors[r.key] ? " is-error" : ""}`}
                            style={{ flex: `0 1 ${WIDTH[r.cls]}px`, maxWidth: "100%" }}
                            value={form[r.key]}
                            placeholder={r.placeholder}
                            onChange={(e) => setForm({ ...form, [r.key]: e.target.value })}
                            aria-invalid={!!errors[r.key]}
                          />
                          {errors[r.key] && (
                            <span className="err" role="alert">
                              {errors[r.key]}
                            </span>
                          )}
                        </>
                      ) : (
                        <span>{form[r.key] || "-"}</span>
                      )}
                    </FormRow>
                  ))}
                </FormSection>
              </form>
              {canAudit && (
                <FormSection
                  title="변경 이력"
                  actions={
                    <span className="row" style={{ gap: 8 }}>
                      <span className="t-c1 c-alt">저장할 때마다 바뀐 항목이 로그 추적에 남습니다</span>
                      <Link className="btn btn-sm btn-out" href="/admin/logs?action=platform.business_info.update">
                        로그 추적
                      </Link>
                    </span>
                  }
                >
                  <tr>
                    <td colSpan={2}>
                      <table className="tbl" data-testid="pb-history">
                        <thead>
                          <tr>
                            <th>일시</th>
                            <th>변경 항목</th>
                            <th>처리</th>
                          </tr>
                        </thead>
                        <tbody>
                          {history === null || history.length === 0 ? (
                            <tr>
                              <td colSpan={3} className="c-alt">
                                {history === null ? "불러오는 중" : "아직 변경 기록이 없습니다"}
                              </td>
                            </tr>
                          ) : (
                            history.map((h) => (
                              <tr key={h.id}>
                                <td>{formatDateTime(h.at, "-")}</td>
                                <td className="col-text">{h.fields.map((f) => LABEL[f as Key] ?? f).join(" · ") || "-"}</td>
                                <td>{h.actor}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                </FormSection>
              )}
              {canEdit && (
                <FormFoot>
                  <button className="btn btn-lg" type="submit" form="pb-form" disabled={changed.length === 0}>
                    저장
                  </button>
                  <button className="btn btn-lg btn-out" type="button" disabled={changed.length === 0} onClick={() => (setForm(toForm(state.info)), setErrors({}))}>
                    취소
                  </button>
                </FormFoot>
              )}
            </>
          )}
        </div>
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
