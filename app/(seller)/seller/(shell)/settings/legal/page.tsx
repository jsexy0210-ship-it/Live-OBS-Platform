"use client";

import { useCallback, useEffect, useState } from "react";
import { FormFoot, FormRow, FormSection, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";

// SA-062 법정 고지·약관(파트너스 관리자, 설정 › 쇼핑몰 설정): 쇼핑몰 이용약관·개인정보처리방침 입력.
// 입력한 글이 구매자 쇼핑몰(/shop/{슬러그}/terms·privacy)에 글자 그대로 표시된다. 게시하기 전에는 구매자에게 「준비 중」으로 보인다.
// 보기는 모든 직원, 바꾸기는 대표자·「쇼핑몰 설정」 권한 직원. API: GET·PUT /api/seller/shop-legal/{terms|privacy}(lib/server/shop-legal/service.ts).
// 서버의 본문 상한과 같은 값(서버 모듈은 prisma를 끌어오므로 화면에서 가져오지 않는다). 화면 문구는 명사형·합니다체.
const BODY_MAX = 60_000;

type Kind = "terms" | "privacy";
type Doc = { kind: Kind; body: string; effectiveOn: string | null; isPublished: boolean; version: number };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: Doc };

const TABS: { key: Kind; label: string }[] = [
  { key: "terms", label: "이용약관" },
  { key: "privacy", label: "개인정보처리방침" },
];
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
  // 긴 글을 입력하다 닫으면 잃으므로 저장하지 않은 변경이 있으면 닫기 전에 묻는다
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const length = [...body].length;
  const bodyError = length > BODY_MAX ? `본문은 ${BODY_MAX.toLocaleString("ko-KR")}자까지 입력할 수 있습니다` : published && !body.trim() ? "게시하려면 본문을 입력해 주십시오" : null;
  const dateError = published && !date ? "게시하려면 시행일을 입력해 주십시오" : null;

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
      return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    }
    apply(r.data.doc);
    setShowError(false);
    setState({ kind: "ok", saved: r.data.doc });
    setToast(r.data.doc.isPublished ? `${label}을 저장했습니다 · 구매자 화면에 게시 중` : `${label}을 저장했습니다 · 게시 전`);
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
          <FormRow label="구매자 화면" help="입력한 내용이 구매자 쇼핑몰 바닥글 링크에 그대로 표시됩니다 · 저장한 뒤에 반영">
            <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <span className="t-l2" data-testid={`legal-status-${kind}`}>
                {saved?.isPublished && saved.effectiveOn ? `게시 중 · 시행일 ${korDate(saved.effectiveOn)}` : "게시 전 · 구매자에게는 준비 중으로 표시"}
              </span>
              <a className="btn btn-sm btn-out" href={`/shop/${slug}/${kind}`} target="_blank" rel="noreferrer">
                구매자 화면 보기
              </a>
            </div>
          </FormRow>
          <FormRow label="시행일" help="게시하려면 필요합니다">
            <div className="col" style={{ gap: 4 }}>
              <input className={`inp${showError && dateError ? " is-error" : ""}`} type="date" aria-label={`${label} 시행일`} aria-invalid={showError && !!dateError} readOnly={!editable} value={date} onChange={(e) => setDate(e.target.value)} />
              {showError && dateError && <span className="err" role="alert">{dateError}</span>}
            </div>
          </FormRow>
          <FormRow label="본문" help="글자 그대로 표시됩니다 · 표·서식은 지원하지 않습니다">
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
          <FormRow label="구매자에게 게시" help={published ? "저장하면 구매자 화면에 바로 표시됩니다" : "꺼 두면 구매자에게는 준비 중으로 보입니다 · 기본 꺼짐"}>
            <button className={`sw${published ? " on" : ""}`} type="button" role="switch" aria-checked={published} aria-label={`${label} 구매자에게 게시`} disabled={!editable} onClick={() => setPublished((v) => !v)} />
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

export default function LegalSettingsPage() {
  const { me, can } = useSeller();
  const editable = can("SHOP_SETTINGS");
  const [tab, setTab] = useState<Kind>("terms");
  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 법정 고지 · 약관" />
      <main className="main">
        <PageHead title="법정 고지 · 약관" />
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
        {TABS.map((t) => (
          <LegalPanel key={t.key} kind={t.key} label={t.label} slug={me.shop.slug} editable={editable} visible={tab === t.key} />
        ))}
      </main>
    </>
  );
}
