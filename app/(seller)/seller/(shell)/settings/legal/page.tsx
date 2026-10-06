"use client";

import { useCallback, useEffect, useState } from "react";
import { FormFoot, FormRow, FormSection, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import "./legal.css";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";
import { DatePicker } from "../../../../../../components/admin-ui/DatePicker";

// SA-062 법정 고지·약관(파트너스 관리자, 설정 › 쇼핑몰 설정): 쇼핑몰 이용약관·개인정보처리방침 입력.
// 입력한 글이 구매자 쇼핑몰(/shop/{슬러그}/terms·privacy)에 글자 그대로 표시된다. 게시하기 전에는 구매자에게 「준비 중」으로 보인다.
// 보기는 모든 직원, 바꾸기는 대표자·「쇼핑몰 설정」 권한 직원. API: GET·PUT /api/seller/shop-legal/{terms|privacy}(lib/server/shop-legal/service.ts).
// 세 번째 탭 「사업자 정보·고지」: 쇼핑몰 바닥글의 주소·고객센터·구매안전서비스·미성년자 구매 안내 입력(API GET·PUT /api/seller/shop-legal-notice, lib/server/shop-legal/notice.ts).
// 상호·대표자·사업자등록번호·통신판매업 신고번호는 입점 신청 때 받은 검증 값이라 읽기 전용으로만 보여 준다.
// 서버의 상한과 같은 값(서버 모듈은 prisma를 끌어오므로 화면에서 가져오지 않는다). 화면 문구는 명사형·합니다체.
const BODY_MAX = 60_000;
const ADDRESS_MAX = 200;
const HOURS_MAX = 100;
const PROVIDER_MAX = 60;
const URL_MAX = 300;
const MINOR_MAX = 1000;
const EMAIL_MAX = 100;

type Kind = "terms" | "privacy";
type Doc = { kind: Kind; body: string; effectiveOn: string | null; isPublished: boolean; version: number };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: Doc };

type Tab = Kind | "notice";
const TABS: { key: Tab; label: string }[] = [
  { key: "terms", label: "이용약관" },
  { key: "privacy", label: "개인정보처리방침" },
  { key: "notice", label: "사업자 정보·고지" },
];
const DOC_TABS = TABS.filter((t): t is { key: Kind; label: string } => t.key !== "notice");
const korDate = (iso: string) => iso.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_m, y, mo, d) => `${y}년 ${+mo}월 ${+d}일`);

function LegalPanel({ kind, label, slug, editable, visible }: { kind: Kind; label: string; slug: string; editable: boolean; visible: boolean }) {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [body, setBody] = useState("");
  const [date, setDate] = useState("");
  const [published, setPublished] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showError, setShowError] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const apply = (d: Doc) => {
    setBody(d.body);
    setDate(d.effectiveOn ?? "");
    setPublished(d.isPublished);
  };
  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ doc: Doc }>(`/api/seller/shop-legal/${kind}`);
    if (!r.ok) return setState({ kind: "error", status: r.status });
    apply(r.data.doc);
    setFailure(null);
    setConflict(false);
    setShowError(false);
    setState({ kind: "ok", saved: r.data.doc });
  }, [kind]);
  useEffect(() => {
    void load();
  }, [load]);

  const saved = state.kind === "ok" ? state.saved : null;
  const dirty = !!saved && (saved.body !== body || (saved.effectiveOn ?? "") !== date || saved.isPublished !== published);
  useUnsavedGuard(dirty); // 링크·브라우저 Back·새로고침에 같은 확인(docs/IA.md Back 규칙 7항)

  const length = [...body].length;
  const bodyError = length > BODY_MAX ? `본문은 ${BODY_MAX.toLocaleString("ko-KR")}자까지 입력할 수 있습니다` : published && !body.trim() ? "공개하려면 본문을 써 주십시오" : null;
  const dateError = published && !date ? "공개하려면 시작하는 날을 정해 주십시오" : null;

  const save = async () => {
    if (!saved || saving) return;
    setShowError(true);
    if (bodyError || dateError) return;
    setSaving(true);
    setFailure(null);
    setConflict(false);
    const r = await api<{ doc: Doc }>(`/api/seller/shop-legal/${kind}`, { method: "PUT", body: { body, effectiveOn: date || null, isPublished: published, expectedVersion: saved.version } });
    setSaving(false);
    if (!r.ok) {
      if (r.error === "version_conflict") setConflict(true);
      return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오"));
    }
    apply(r.data.doc);
    setShowError(false);
    setState({ kind: "ok", saved: r.data.doc });
    setToast(r.data.doc.isPublished ? `${label}을 저장했습니다 · 구매자 화면에 공개 중` : `${label}을 저장했습니다 · 아직 공개 안 함`);
  };

  if (state.kind !== "ok") {
    return (
      <div className="card" hidden={!visible}>
        {state.kind === "loading" && <LoadingRows rows={3} />}
        {state.kind === "error" && (state.status === 402 ? <Locked /> : <ErrorState title={`${label}을 불러오지 못했습니다`} onRetry={() => void load()} />)}
      </div>
    );
  }

  return (
    <form
      hidden={!visible}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset className="settings-fields" disabled={saving}>
        {failure && (
          <div className="msg msg-neg" role="alert" style={{ marginBottom: 16 }}>
            <span>
              <b>저장할 수 없습니다.</b> {failure}
            </span>
            {conflict && (
              <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
                최신 내용 불러오기
              </button>
            )}
          </div>
        )}
        <FormSection title={label}>
          <FormRow label="구매자 화면" help="구매자 쇼핑몰 맨 아래 링크에 쓴 글이 그대로 보입니다 · 저장해야 바뀝니다">
            <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <span className="t-l2" data-testid={`legal-status-${kind}`}>
                {saved?.isPublished && saved.effectiveOn ? `공개 중 · 시작하는 날 ${korDate(saved.effectiveOn)}` : "아직 공개 안 함 · 구매자에게는 「준비 중」으로 보입니다"}
              </span>
              <a className="btn btn-sm btn-out" href={`/shop/${slug}/${kind}`} target="_blank" rel="noreferrer">
                구매자 화면 보기
              </a>
            </div>
          </FormRow>
          <FormRow label="시작하는 날" help="공개하려면 필요합니다">
            <div className="col" style={{ gap: 4 }}>
              <DatePicker className={`${showError && dateError ? " is-error" : ""}`} aria-label={`${label} 시작하는 날`} aria-invalid={showError && !!dateError} readOnly={!editable} value={date} onChange={(v) => setDate(v)} />
              {showError && dateError && <span className="err" role="alert">{dateError}</span>}
            </div>
          </FormRow>
          <FormRow label="본문" help="쓴 글이 그대로 보입니다 · 표나 글자 꾸미기는 쓸 수 없습니다">
            <div className="col" style={{ gap: 4, width: "100%", maxWidth: 820 }}>
              <textarea
                className={`inp${showError && bodyError ? " is-error" : ""}`}
                style={{ width: "100%" }}
                rows={20}
                readOnly={!editable}
                aria-label={`${label} 본문`}
                aria-invalid={showError && !!bodyError}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
              {showError && bodyError ? (
                <span className="err" role="alert">{bodyError}</span>
              ) : (
                <span className="t-c1 c-alt">
                  {length.toLocaleString("ko-KR")} / {BODY_MAX.toLocaleString("ko-KR")}자
                </span>
              )}
            </div>
          </FormRow>
          <FormRow label="구매자에게 공개" help={published ? "저장하면 구매자 화면에 바로 보입니다" : "꺼 두면 구매자에게는 「준비 중」으로 보입니다 · 기본 꺼짐"}>
            <button className={`sw${published ? " on" : ""}`} type="button" role="switch" aria-checked={published} aria-label={`${label} 구매자에게 공개`} disabled={!editable} onClick={() => setPublished((v) => !v)} />
          </FormRow>
        </FormSection>
      </fieldset>
      {editable && (
        <FormFoot>
          <button className="btn btn-lg" type="submit" disabled={saving || !dirty} data-testid={`legal-save-${kind}`}>
            {saving ? "저장 중" : "저장"}
          </button>
        </FormFoot>
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </form>
  );
}

// ───────── 사업자 정보·고지 ─────────
type Escrow = "none" | "escrow" | "insurance";
type Notice = { address: string; csPhone: string; csEmail: string; csHours: string; escrowKind: Escrow; escrowProvider: string; escrowUrl: string; minorNotice: string; version: number };
type Business = { companyName: string | null; representativeName: string | null; businessNumber: string | null; mailOrderNumber: string | null };
type NoticeLoad = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: Notice; business: Business };
type Form = Omit<Notice, "version">;
const ESCROW_CHOICES: { key: Escrow; label: string }[] = [
  { key: "none", label: "가입하지 않음" },
  { key: "escrow", label: "에스크로(결제 대금을 맡아 주는 서비스)" },
  { key: "insurance", label: "소비자 피해 보상 보험" },
];
const PHONE = /^[0-9+\-() ]{5,30}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY: Form = { address: "", csPhone: "", csEmail: "", csHours: "", escrowKind: "none", escrowProvider: "", escrowUrl: "", minorNotice: "" };
const pick = (n: Notice): Form => ({ address: n.address, csPhone: n.csPhone, csEmail: n.csEmail, csHours: n.csHours, escrowKind: n.escrowKind, escrowProvider: n.escrowProvider, escrowUrl: n.escrowUrl, minorNotice: n.minorNotice });
const bizNo = (v: string | null) => (v && /^\d{10}$/.test(v) ? `${v.slice(0, 3)}-${v.slice(3, 5)}-${v.slice(5)}` : v);

function httpsOk(v: string) {
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".");
  } catch {
    return false;
  }
}
function validate(f: Form): Partial<Record<keyof Form, string>> {
  const e: Partial<Record<keyof Form, string>> = {};
  const n = (v: string) => [...v.trim()].length;
  if (n(f.address) > ADDRESS_MAX) e.address = `주소는 ${ADDRESS_MAX}자까지 입력할 수 있습니다`;
  if (f.csPhone.trim() && !PHONE.test(f.csPhone.trim())) e.csPhone = "전화번호는 숫자·하이픈·괄호만 입력할 수 있습니다";
  if (f.csEmail.trim() && (f.csEmail.trim().length > EMAIL_MAX || !EMAIL.test(f.csEmail.trim()))) e.csEmail = "이메일 주소를 다시 확인해 주십시오";
  if (n(f.csHours) > HOURS_MAX) e.csHours = `운영시간은 ${HOURS_MAX}자까지 입력할 수 있습니다`;
  if (f.escrowKind !== "none" && !f.escrowProvider.trim()) e.escrowProvider = "가입한 업체 이름을 입력해 주십시오";
  if (n(f.escrowProvider) > PROVIDER_MAX) e.escrowProvider = `업체 이름은 ${PROVIDER_MAX}자까지 입력할 수 있습니다`;
  if (f.escrowUrl.trim() && (f.escrowUrl.trim().length > URL_MAX || !httpsOk(f.escrowUrl))) e.escrowUrl = "확인 주소는 https://로 시작하는 주소만 쓸 수 있습니다";
  if (n(f.minorNotice) > MINOR_MAX) e.minorNotice = `미성년자 구매 안내는 ${MINOR_MAX.toLocaleString("ko-KR")}자까지 입력할 수 있습니다`;
  return e;
}

function NoticePanel({ editable, visible }: { editable: boolean; visible: boolean }) {
  const [state, setState] = useState<NoticeLoad>({ kind: "loading" });
  const [form, setForm] = useState<Form>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [showError, setShowError] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ notice: Notice; business: Business }>("/api/seller/shop-legal-notice");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setForm(pick(r.data.notice));
    setFailure(null);
    setConflict(false);
    setShowError(false);
    setState({ kind: "ok", saved: r.data.notice, business: r.data.business });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const saved = state.kind === "ok" ? state.saved : null;
  const dirty = !!saved && (Object.keys(EMPTY) as (keyof Form)[]).some((k) => saved[k] !== form[k]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const errors = validate(form);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const save = async () => {
    if (!saved || saving) return;
    setShowError(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setFailure(null);
    setConflict(false);
    const r = await api<{ notice: Notice; business: Business }>("/api/seller/shop-legal-notice", { method: "PUT", body: { ...form, expectedVersion: saved.version } });
    setSaving(false);
    if (!r.ok) {
      if (r.error === "version_conflict") setConflict(true);
      return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오"));
    }
    setForm(pick(r.data.notice));
    setShowError(false);
    setState({ kind: "ok", saved: r.data.notice, business: r.data.business });
    setToast("사업자 정보·고지를 저장했습니다 · 구매자 바닥글에 반영");
  };

  if (state.kind !== "ok") {
    return (
      <div className="card" hidden={!visible}>
        {state.kind === "loading" && <LoadingRows rows={3} />}
        {state.kind === "error" && (state.status === 402 ? <Locked /> : <ErrorState title="사업자 정보·고지를 불러오지 못했습니다" onRetry={() => void load()} />)}
      </div>
    );
  }
  const biz = state.business;
  const err = (k: keyof Form) => (showError ? errors[k] : undefined);
  const field = (k: keyof Form, label: string, props: { help?: string; max?: number; type?: string; placeholder?: string } = {}) => (
    <FormRow label={label} help={props.help}>
      <div className="col" style={{ gap: 4, width: "100%", maxWidth: 560 }}>
        <input
          className={`inp${err(k) ? " is-error" : ""}`}
          type={props.type ?? "text"}
          aria-label={label}
          aria-invalid={!!err(k)}
          readOnly={!editable}
          value={form[k]}
          placeholder={props.placeholder}
          onChange={(e) => set({ [k]: e.target.value } as Partial<Form>)}
        />
        {err(k) && <span className="err" role="alert">{err(k)}</span>}
      </div>
    </FormRow>
  );

  return (
    <form
      hidden={!visible}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <fieldset className="settings-fields" disabled={saving}>
        {failure && (
          <div className="msg msg-neg" role="alert" style={{ marginBottom: 16 }}>
            <span>
              <b>저장할 수 없습니다.</b> {failure}
            </span>
            {conflict && (
              <button className="btn btn-sm btn-out" type="button" onClick={() => void load()}>
                최신 내용 불러오기
              </button>
            )}
          </div>
        )}
        <FormSection title="사업자 정보">
          <FormRow label="처음 신청할 때 받은 정보" help="처음 신청할 때 받아 확인한 값입니다 · 여기서는 바꿀 수 없습니다">
            <dl className="legal-biz" data-testid="legal-biz">
              <div><dt>상호</dt><dd>{biz.companyName ?? "-"}</dd></div>
              <div><dt>대표자</dt><dd>{biz.representativeName ?? "-"}</dd></div>
              <div><dt>사업자등록번호</dt><dd>{bizNo(biz.businessNumber) ?? "-"}</dd></div>
              <div><dt>통신판매업 신고번호</dt><dd>{biz.mailOrderNumber ?? "-"}</dd></div>
            </dl>
          </FormRow>
        </FormSection>
        <div style={{ marginTop: 32 }}>
          <FormSection title="구매자 쇼핑몰 바닥글">
            {field("address", "주소", { help: "입력한 항목만 바닥글에 표시됩니다 · 저장한 뒤에 반영" })}
            {field("csPhone", "고객센터 전화", { placeholder: "전화번호 입력", help: "예: 1588-1234" })}
            {field("csEmail", "이메일", { type: "email" })}
            {field("csHours", "운영시간", { placeholder: "운영시간 입력", help: "예: 평일 10:00~17:00" })}
            <FormRow label="쇼핑몰 제공" help="쇼핑몰 맨 아래에 플랫폼 이름이 자동으로 나옵니다">
              <span className="t-l2">ONQ</span>
            </FormRow>
          </FormSection>
        </div>
        <div style={{ marginTop: 32 }}>
          <FormSection title="구매 안전 서비스">
            <FormRow label="가입 종류" help="가입한 경우에만 선택합니다 · 가입 정보는 입력한 그대로 표시됩니다">
              <div className="seg" role="radiogroup" aria-label="구매 안전 서비스 가입 종류">
                {ESCROW_CHOICES.map((c) => (
                  <button key={c.key} type="button" role="radio" aria-checked={form.escrowKind === c.key} className={form.escrowKind === c.key ? "on" : ""} disabled={!editable} onClick={() => set({ escrowKind: c.key })}>
                    {c.label}
                  </button>
                ))}
              </div>
            </FormRow>
            {form.escrowKind !== "none" && (
              <>
                {field("escrowProvider", "가입한 업체")}
                {field("escrowUrl", "확인 주소", { help: "선택 · 가입 사실을 확인할 수 있는 https 주소", placeholder: "확인 주소 입력" })}
              </>
            )}
          </FormSection>
        </div>
        <div style={{ marginTop: 32 }}>
          <FormSection title="미성년자 구매 안내">
            <FormRow label="안내 글" help="입력한 글이 바닥글에 그대로 표시됩니다 · 비워 두면 표시하지 않습니다">
              <div className="col" style={{ gap: 4, width: "100%", maxWidth: 820 }}>
                <textarea
                  className={`inp${err("minorNotice") ? " is-error" : ""}`}
                  style={{ width: "100%" }}
                  rows={6}
                  aria-label="미성년자 구매 안내"
                  aria-invalid={!!err("minorNotice")}
                  readOnly={!editable}
                  value={form.minorNotice}
                  onChange={(e) => set({ minorNotice: e.target.value })}
                />
                {err("minorNotice") ? (
                  <span className="err" role="alert">{err("minorNotice")}</span>
                ) : (
                  <span className="t-c1 c-alt">
                    {[...form.minorNotice].length.toLocaleString("ko-KR")} / {MINOR_MAX.toLocaleString("ko-KR")}자
                  </span>
                )}
              </div>
            </FormRow>
          </FormSection>
        </div>
      </fieldset>
      {editable && (
        <FormFoot>
          <button className="btn btn-lg" type="submit" disabled={saving || !dirty} data-testid="legal-save-notice">
            {saving ? "저장 중" : "저장"}
          </button>
        </FormFoot>
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </form>
  );
}

export default function LegalSettingsPage() {
  const { me, can } = useSeller();
  const editable = can("SHOP_SETTINGS");
  const [tab, setTab] = useState<Tab>("terms");
  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 법정 고지 · 약관" />
      <main className="main">
        <PageHead description="구매자에게 공개할 법정 고지와 약관을 관리합니다." title="법정 고지 · 약관" />
        {!editable && (
          <div className="msg msg-info" role="status" style={{ marginBottom: 16 }}>
            <span>보기만 할 수 있습니다. 변경은 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        <div className="tabs" role="tablist" style={{ marginBottom: 16 }}>
          {TABS.map((t) => (
            <button key={t.key} className={`tab${tab === t.key ? " on" : ""}`} type="button" role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        {/* 두 문서를 모두 불러 두고 탭은 보이는 쪽만 바꾼다(탭을 옮겨도 입력 중인 내용이 사라지지 않게) */}
        {DOC_TABS.map((t) => (
          <LegalPanel key={t.key} kind={t.key} label={t.label} slug={me.shop.slug} editable={editable} visible={tab === t.key} />
        ))}
        <NoticePanel editable={editable} visible={tab === "notice"} />
      </main>
    </>
  );
}
