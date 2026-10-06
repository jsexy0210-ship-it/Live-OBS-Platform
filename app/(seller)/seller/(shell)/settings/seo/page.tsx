"use client";

import { useCallback, useEffect, useState } from "react";
import { FormFoot, FormRow, FormSection, Modal, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";

// SA-067 검색 노출(파트너스 관리자, 설정 › 쇼핑몰 설정). API: GET·PUT /api/seller/seo (쇼핑몰 설정 권한 필요).
// PUT은 바뀐 항목만 보낸다(문자 값은 빈 값이면 지운다). 검색 노출을 끄는 저장은 확인 창을 거친다.
// 서버 lib/server/seller-settings/shopSeo.ts의 한도와 같은 값(서버 모듈은 prisma를 끌어오므로 화면에서 가져오지 않는다).
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;
const VERIFICATION_MAX = 100;
const PLACEHOLDERS = new Set(["상품명", "쇼핑몰"]);
const VERIFICATION = /^[A-Za-z0-9_-]+$/;

type Seo = {
  searchTitle: string | null;
  searchDescription: string | null;
  indexingEnabled: boolean;
  sitemapEnabled: boolean;
  productTitleTemplate: string | null;
  productDescriptionTemplate: string | null;
  googleVerification: string | null;
  naverVerification: string | null;
};
type Form = Record<"searchTitle" | "searchDescription" | "productTitleTemplate" | "productDescriptionTemplate" | "googleVerification" | "naverVerification", string> & {
  indexingEnabled: boolean;
  sitemapEnabled: boolean;
};
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: Seo };

const toForm = (s: Seo): Form => ({
  searchTitle: s.searchTitle ?? "",
  searchDescription: s.searchDescription ?? "",
  indexingEnabled: s.indexingEnabled,
  sitemapEnabled: s.sitemapEnabled,
  productTitleTemplate: s.productTitleTemplate ?? "",
  productDescriptionTemplate: s.productDescriptionTemplate ?? "",
  googleVerification: s.googleVerification ?? "",
  naverVerification: s.naverVerification ?? "",
});

const len = (v: string) => [...v.trim()].length;
function lengthError(v: string, max: number, what: string) {
  return len(v) > max ? `${what}은 ${max}자까지 입력할 수 있습니다` : null;
}
// 규칙에는 {상품명}·{쇼핑몰}만 쓸 수 있다
function templateError(v: string, max: number, what: string) {
  const long = lengthError(v, max, what);
  if (long) return long;
  return [...v.matchAll(/\{([^{}]*)\}|[{}]/g)].some((m) => m[1] === undefined || !PLACEHOLDERS.has(m[1])) ? "{상품명}, {쇼핑몰}만 쓸 수 있습니다" : null;
}
function codeError(v: string) {
  const t = v.trim();
  if (t === "") return null;
  if (t.length > VERIFICATION_MAX) return `확인 코드는 ${VERIFICATION_MAX}자까지 입력할 수 있습니다`;
  return VERIFICATION.test(t) ? null : "영문, 숫자, -, _ 만 입력할 수 있습니다";
}

const TEXT_KEYS = ["searchTitle", "searchDescription", "productTitleTemplate", "productDescriptionTemplate", "googleVerification", "naverVerification"] as const;

export default function SeoSettingsPage() {
  const { me } = useSeller();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [form, setForm] = useState<Form | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ seo: Seo }>("/api/seller/seo");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setForm(toForm(r.data.seo));
    setState({ kind: "ok", saved: r.data.seo });
  }, []);
  useEffect(() => void load(), [load]);

  const saved = state.kind === "ok" ? state.saved : null;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const errors = form && {
    searchTitle: lengthError(form.searchTitle, TITLE_MAX, "제목"),
    searchDescription: lengthError(form.searchDescription, DESCRIPTION_MAX, "설명"),
    productTitleTemplate: templateError(form.productTitleTemplate, TITLE_MAX, "제목 규칙"),
    productDescriptionTemplate: templateError(form.productDescriptionTemplate, DESCRIPTION_MAX, "설명 규칙"),
    googleVerification: codeError(form.googleVerification),
    naverVerification: codeError(form.naverVerification),
  };
  const valid = !!errors && Object.values(errors).every((e) => !e);

  // 바뀐 항목만. 문자 값은 앞뒤 공백을 지우고, 비면 null(서버가 지움)
  const changes = (): Partial<Seo> => {
    if (!form || !saved) return {};
    const out: Partial<Seo> = {};
    for (const k of TEXT_KEYS) {
      const next = form[k].trim() === "" ? null : form[k].trim();
      if (next !== saved[k]) out[k] = next;
    }
    if (form.indexingEnabled !== saved.indexingEnabled) out.indexingEnabled = form.indexingEnabled;
    if (form.sitemapEnabled !== saved.sitemapEnabled) out.sitemapEnabled = form.sitemapEnabled;
    return out;
  };
  const patch = changes();
  const dirty = Object.keys(patch).length > 0;
  useUnsavedGuard(dirty); // 링크·브라우저 Back·새로고침에 같은 확인(docs/IA.md Back 규칙 7항)
  const turningOff = patch.indexingEnabled === false;

  const send = async () => {
    setSaving(true);
    setFailure(null);
    const r = await api<{ seo: Seo }>("/api/seller/seo", { method: "PUT", body: patch });
    setSaving(false);
    setConfirmOff(false);
    if (!r.ok) return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    setForm(toForm(r.data.seo));
    setState({ kind: "ok", saved: r.data.seo });
    setShowErrors(false);
    setToast("검색 노출 설정을 저장했습니다");
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return setShowErrors(true);
    if (!dirty) return;
    if (turningOff) return setConfirmOff(true);
    void send();
  };

  const err = (k: keyof NonNullable<typeof errors>) => (showErrors && errors?.[k] ? errors[k] : null);
  const shopName = me.shop.name;
  const previewTitle = form?.searchTitle.trim() || shopName;
  const previewDesc = form?.searchDescription.trim() || "설명을 입력하면 검색 결과에 보입니다";

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 검색 노출" />
      <main className="main">
        <PageHead description="검색 사이트에 표시할 쇼핑몰 제목과 설명을 설정합니다." title="검색 노출" />
        {state.kind === "loading" && (
          <div className="card">
            <LoadingRows rows={6} />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card">
            {state.status === 403 ? <NoPermission need="쇼핑몰 설정" /> : state.status === 402 ? <Locked /> : <ErrorState title="검색 노출 설정을 불러오지 못했습니다" onRetry={() => void load()} />}
          </div>
        )}
        {state.kind === "ok" && form && errors && (
          <form onSubmit={submit} noValidate>
            {failure && (
              <div className="msg msg-neg" role="alert" style={{ marginBottom: 16 }}>
                <span>{failure}</span>
              </div>
            )}
            {!form.indexingEnabled && (
              <div className="msg msg-cau" role="note" data-testid="indexing-off" style={{ marginBottom: 16 }}>
                <span>검색 노출이 꺼져 있습니다. 검색 사이트에 쇼핑몰이 나오지 않습니다.</span>
              </div>
            )}

            <FormSection title="쇼핑몰 기본">
              <FormRow label="검색 노출" help="허용 안 함이면 검색엔진에 「수집 금지」로 안내합니다 · 이미 나온 결과가 사라지기까지는 시간이 걸립니다">
                <div className="row" style={{ gap: 16 }} role="radiogroup" aria-label="검색 노출">
                  <label className="chk">
                    <input type="radio" name="seo-indexing" checked={form.indexingEnabled} onChange={() => set("indexingEnabled", true)} />
                    허용
                  </label>
                  <label className="chk">
                    <input type="radio" name="seo-indexing" checked={!form.indexingEnabled} onChange={() => set("indexingEnabled", false)} />
                    허용 안 함
                  </label>
                </div>
              </FormRow>
              <FormRow label="검색 제목" htmlFor="seo-title" help={err("searchTitle") ? <span className="err">{err("searchTitle")}</span> : `비우면 쇼핑몰 이름을 씁니다 · ${len(form.searchTitle)} / ${TITLE_MAX}자`}>
                <input id="seo-title" placeholder="검색 제목 입력" className={`inp${err("searchTitle") ? " is-error" : ""}`} type="text" value={form.searchTitle} onChange={(e) => set("searchTitle", e.target.value)} aria-invalid={!!err("searchTitle")} style={{ width: "100%", maxWidth: 480 }} aria-description="검색 결과에 보일 제목 (60자)" />
              </FormRow>
              <FormRow label="검색 설명" htmlFor="seo-desc" help={err("searchDescription") ? <span className="err">{err("searchDescription")}</span> : `${len(form.searchDescription)} / ${DESCRIPTION_MAX}자`}>
                <textarea id="seo-desc" placeholder="검색 설명 입력" className={`inp${err("searchDescription") ? " is-error" : ""}`} rows={3} value={form.searchDescription} onChange={(e) => set("searchDescription", e.target.value)} aria-invalid={!!err("searchDescription")} style={{ width: "100%", maxWidth: 480 }} aria-description="검색 결과에 보일 설명 (160자)" />
              </FormRow>
              <FormRow label="사이트맵" help="검색 사이트가 상품 주소를 찾을 수 있게 목록을 제공합니다">
                  <label className="chk">
                    <input type="checkbox" checked={form.sitemapEnabled} onChange={(e) => set("sitemapEnabled", e.target.checked)} />
                    사이트맵 제공
                  </label>
                </FormRow>
              <FormRow label="구글 확인 코드" htmlFor="seo-google" help={err("googleVerification") ? <span className="err">{err("googleVerification")}</span> : "구글 서치 콘솔이 알려 주는 메타 태그의 content 값만 입력합니다"}>
                  <input id="seo-google" placeholder="확인 코드 입력" className={`inp${err("googleVerification") ? " is-error" : ""}`} type="text" value={form.googleVerification} onChange={(e) => set("googleVerification", e.target.value)} aria-invalid={!!err("googleVerification")} style={{ width: "100%", maxWidth: 480 }} aria-description="검색 도구에서 받은 확인 코드" />
                </FormRow>
              <FormRow label="네이버 확인 코드" htmlFor="seo-naver" help={err("naverVerification") ? <span className="err">{err("naverVerification")}</span> : "네이버 서치어드바이저가 알려 주는 메타 태그의 content 값만 입력합니다"}>
                  <input id="seo-naver" placeholder="확인 코드 입력" className={`inp${err("naverVerification") ? " is-error" : ""}`} type="text" value={form.naverVerification} onChange={(e) => set("naverVerification", e.target.value)} aria-invalid={!!err("naverVerification")} style={{ width: "100%", maxWidth: 480 }} aria-description="검색 도구에서 받은 확인 코드" />
                </FormRow>
            </FormSection>
            <p className="help" style={{ marginTop: 8 }}>파비콘과 공유 카드 이미지는 「공유 설정」에서 바꿉니다.</p>

            <div style={{ marginTop: 32 }}>
              <FormSection title="상품별 자동 생성 규칙">
                <FormRow
                  label="상품 제목 규칙"
                  htmlFor="seo-ptitle"
                  help={err("productTitleTemplate") ? <span className="err">{err("productTitleTemplate")}</span> : `{상품명}, {쇼핑몰}을 넣을 수 있습니다 · 비우면 기본 형식을 씁니다 · ${len(form.productTitleTemplate)} / ${TITLE_MAX}자`}
                >
                  <input id="seo-ptitle" className={`inp${err("productTitleTemplate") ? " is-error" : ""}`} type="text" value={form.productTitleTemplate} placeholder="제목 규칙 입력" onChange={(e) => set("productTitleTemplate", e.target.value)} aria-invalid={!!err("productTitleTemplate")} style={{ width: "100%", maxWidth: 480 }} aria-description="{상품명} | {쇼핑몰}" />
                </FormRow>
                <FormRow
                  label="상품 설명 규칙"
                  htmlFor="seo-pdesc"
                  help={err("productDescriptionTemplate") ? <span className="err">{err("productDescriptionTemplate")}</span> : `{상품명}, {쇼핑몰}을 넣을 수 있습니다 · ${len(form.productDescriptionTemplate)} / ${DESCRIPTION_MAX}자`}
                >
                  <textarea id="seo-pdesc" className={`inp${err("productDescriptionTemplate") ? " is-error" : ""}`} rows={3} value={form.productDescriptionTemplate} onChange={(e) => set("productDescriptionTemplate", e.target.value)} aria-invalid={!!err("productDescriptionTemplate")} style={{ width: "100%", maxWidth: 480 }} />
                </FormRow>
              </FormSection>
            </div>

            <div className="seo-state-grid" style={{ marginTop: 32 }}>
              <FormSection title="노출 상태">
                <FormRow label="검색 노출">
                  <span data-testid="seo-state-indexing">{form.indexingEnabled ? "허용" : "허용 안 함"}</span>
                </FormRow>
                <FormRow label="사이트맵">
                  <span>{form.sitemapEnabled ? "제공" : "제공 안 함"}</span>
                </FormRow>
                <FormRow label="기록">
                  <span className="t-l2">설정 변경은 로그 추적에 남습니다</span>
                </FormRow>
              </FormSection>
              <FormSection title="검색 결과 미리보기">
                <FormRow label="미리보기">
                <div className="card" data-testid="seo-preview" style={{ padding: 12, maxWidth: 480 }}>
                  <div className="t-l1 fw6">{previewTitle}</div>
                  <div className="t-c1 c-alt">{previewDesc}</div>
                </div>
              </FormRow>
              </FormSection>
            </div>

            <FormFoot>
              <button className="btn btn-lg" type="submit" disabled={saving || !dirty} data-testid="seo-save">
                {saving ? "저장 중" : "저장"}
              </button>
            </FormFoot>
          </form>
        )}
      </main>

      {confirmOff && (
        <Modal labelId="seo-off-title" busy={saving} onClose={() => setConfirmOff(false)}>
          <div className="modal-h">
            <h2 className="modal-t" id="seo-off-title">
              검색 노출을 끄시겠습니까?
            </h2>
            <span className="t-l2 c-alt">검색 사이트에 쇼핑몰이 나오지 않도록 요청합니다. 언제든 다시 켤 수 있습니다.</span>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setConfirmOff(false)} disabled={saving}>
              취소
            </button>
            <button className="btn btn-neg" type="button" onClick={() => void send()} disabled={saving} data-testid="seo-off-confirm">
              {saving ? "저장 중" : "끄고 저장"}
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
