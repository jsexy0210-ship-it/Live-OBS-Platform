"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { textLength } from "../../../../../../lib/server/text/clean";
import { AdminTopbar } from "../../../_components/AdminShell";
import { adminApi, failMessage } from "../../../_components/api";

// 사이트 설정 > 파비콘 · 공유 카드(대표님 요구 2026-10-04). 마스터 관리자·파트너스 관리자 화면을 따로 정한다.
// 파비콘: PNG·ICO를 고르면 미리 보고 「바꾸기」로 올린다. 공유 카드: 제목·설명 + 이미지(제목으로 만들기 / 직접 올리기), 저장 전에 미리보기.
// 바꾸기는 최고관리자만(서버가 canEdit으로 알려 줌). 다른 역할은 지금 값만 본다.
// API: GET /api/admin/branding, PUT /api/admin/branding/{target}, PUT·DELETE …/favicon, …/og-image, GET …/card-preview?title=

type Target = "admin" | "seller";
type Branding = {
  target: Target;
  title: string | null;
  description: string | null;
  defaults: { title: string; description: string | null };
  favicon: { url: string; type: string } | null;
  ogImage: { url: string; uploaded: boolean; width: number; height: number };
};
type Settings = { canEdit: boolean; targets: Branding[] };

const TABS: { key: Target; label: string; help: string }[] = [
  { key: "admin", label: "마스터 관리자", help: "마스터 관리자 화면에 적용돼요" },
  { key: "seller", label: "파트너스 관리자", help: "모든 파트너스의 관리자 화면에 똑같이 적용돼요" },
];
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;
const FAVICON_MAX = 256 * 1024;
const OG_MAX = 2 * 1024 * 1024;

// 고른 이미지의 가로·세로(브라우저가 읽을 수 있을 때만, 서버가 다시 확인한다)
function imageSize(url: string): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

type Picked = { file: File; url: string; warn?: string };

export default function BrandingSettingsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Settings }>({ kind: "loading" });
  const [tab, setTab] = useState<Target>("admin");
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await adminApi<Settings>("/api/admin/branding");
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const replace = (b: Branding) =>
    setState((s) => (s.kind === "ok" ? { kind: "ok", data: { ...s.data, targets: s.data.targets.map((x) => (x.target === b.target ? b : x)) } } : s));

  const current = state.kind === "ok" ? state.data.targets.find((t) => t.target === tab) : undefined;

  return (
    <>
      <AdminTopbar crumb="사이트 설정 › 파비콘 · 공유 카드" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">파비콘 · 공유 카드</h1>
            <span className="t-l2 c-alt">브라우저 탭 아이콘과 링크를 공유할 때 보이는 카드를 정해요.</span>
          </div>
        </div>
        <nav className="tabs" role="tablist" aria-label="적용할 화면">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className={`tab${tab === t.key ? " on" : ""}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </nav>
        {state.kind === "loading" && (
          <div className="card st" style={{ boxShadow: "none" }} aria-busy="true">
            <span className="spin" />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card st" style={{ boxShadow: "none" }}>
            <div className="st-ic neg">!</div>
            <span className="t">설정을 불러오지 못했어요</span>
            <button className="btn btn-sm" type="button" onClick={() => void load()}>
              다시 시도
            </button>
          </div>
        )}
        {state.kind === "ok" && current && (
          <>
            {!state.data.canEdit && (
              <div className="msg msg-info" role="status">
                <span>최고관리자만 바꿀 수 있어요. 지금은 보기만 할 수 있어요.</span>
              </div>
            )}
            <span className="t-l2 c-alt">{TABS.find((t) => t.key === tab)!.help}</span>
            {/* 대상을 바꾸면 입력 중이던 값은 버린다(key로 새로 그림) */}
            <TargetForm key={tab} branding={current} canEdit={state.data.canEdit} onSaved={(b, text) => (replace(b), setToast(text))} />
          </>
        )}
      </main>
      {toast && (
        <div className="toast-wrap" role="status">
          <div className="toast">
            <span className="tdot" />
            {toast}
          </div>
        </div>
      )}
    </>
  );
}

function TargetForm({ branding, canEdit, onSaved }: { branding: Branding; canEdit: boolean; onSaved: (b: Branding, toast: string) => void }) {
  const t = branding.target;
  // 파비콘
  const [favicon, setFavicon] = useState<Picked | null>(null);
  const [faviconError, setFaviconError] = useState<string | null>(null);
  const [faviconBusy, setFaviconBusy] = useState(false);
  const faviconInput = useRef<HTMLInputElement>(null);
  // 공유 카드
  const [title, setTitle] = useState(branding.title ?? "");
  const [description, setDescription] = useState(branding.description ?? "");
  const [mode, setMode] = useState<"generated" | "uploaded">(branding.ogImage.uploaded ? "uploaded" : "generated");
  const [ogFile, setOgFile] = useState<Picked | null>(null);
  const [ogError, setOgError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ogInput = useRef<HTMLInputElement>(null);

  // 고른 파일 미리보기 주소는 바뀌거나 화면을 떠날 때 놓아 준다
  useEffect(() => () => void (favicon && URL.revokeObjectURL(favicon.url)), [favicon]);
  useEffect(() => () => void (ogFile && URL.revokeObjectURL(ogFile.url)), [ogFile]);

  const cardTitle = title.trim() || branding.defaults.title;
  // 제목으로 만든 카드 미리보기: 입력을 멈추고 0.4초 뒤 다시 그린다
  const [previewTitle, setPreviewTitle] = useState(cardTitle);
  useEffect(() => {
    const id = setTimeout(() => setPreviewTitle(cardTitle), 400);
    return () => clearTimeout(id);
  }, [cardTitle]);

  const titleLen = textLength(title);
  const descLen = textLength(description);
  const textInvalid = titleLen > TITLE_MAX || descLen > DESCRIPTION_MAX;
  const textDirty = title.trim() !== (branding.title ?? "") || description.trim() !== (branding.description ?? "");
  const imageDirty = mode === "uploaded" ? !!ogFile : branding.ogImage.uploaded;
  const needFile = mode === "uploaded" && !ogFile && !branding.ogImage.uploaded;
  const canSave = canEdit && (textDirty || imageDirty) && !textInvalid && !needFile && !ogError && !saving;

  const pickFavicon = async (file: File | undefined) => {
    setFaviconError(null);
    if (!file) return;
    if (file.size > FAVICON_MAX) return setFaviconError("파비콘은 256KB까지 올릴 수 있어요");
    const url = URL.createObjectURL(file);
    const size = await imageSize(url);
    const warn = size && size.w !== size.h ? "정사각형이 아니면 탭에서 찌그러져 보일 수 있어요" : undefined;
    setFavicon({ file, url, warn });
  };

  const uploadFavicon = async () => {
    if (!favicon) return;
    setFaviconBusy(true);
    setFaviconError(null);
    const r = await adminApi<{ branding: Branding }>(`/api/admin/branding/${t}/favicon`, { method: "PUT", file: favicon.file });
    setFaviconBusy(false);
    if (!r.ok) return setFaviconError(failMessage(r, "파비콘을 바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요"));
    setFavicon(null);
    onSaved(r.data.branding, "파비콘을 바꿨어요");
  };

  const resetFavicon = async () => {
    setFaviconBusy(true);
    setFaviconError(null);
    const r = await adminApi<{ branding: Branding }>(`/api/admin/branding/${t}/favicon`, { method: "DELETE" });
    setFaviconBusy(false);
    if (!r.ok) return setFaviconError(failMessage(r, "되돌리지 못했어요. 잠시 뒤 다시 시도해 주세요"));
    onSaved(r.data.branding, "기본 파비콘으로 되돌렸어요");
  };

  const pickOg = async (file: File | undefined) => {
    setOgError(null);
    setOgFile(null);
    if (!file) return;
    if (file.size > OG_MAX) return setOgError("공유 카드 이미지는 2MB까지 올릴 수 있어요");
    const url = URL.createObjectURL(file);
    const size = await imageSize(url);
    // 브라우저가 열지 못하는 파일(잘린 파일 등)은 공유 서비스도 못 보여 준다
    if (!size) {
      URL.revokeObjectURL(url);
      return setOgError("이미지를 열 수 없어요. PNG·JPG 파일을 골라 주세요");
    }
    if (size.w !== 1200 || size.h !== 630) {
      URL.revokeObjectURL(url);
      return setOgError(`1200×630 크기 이미지를 골라 주세요 · 고른 이미지 ${size.w}×${size.h}`);
    }
    setOgFile({ file, url });
  };

  const save = async () => {
    setSaving(true);
    setFailure(null);
    let latest: Branding | null = null;
    if (textDirty) {
      const r = await adminApi<{ branding: Branding }>(`/api/admin/branding/${t}`, { method: "PUT", json: { title: title.trim() || null, description: description.trim() || null } });
      if (!r.ok) {
        setSaving(false);
        return setFailure(failMessage(r, "저장하지 못했어요. 잠시 뒤 다시 시도해 주세요"));
      }
      latest = r.data.branding;
    }
    if (imageDirty) {
      const r =
        mode === "uploaded" && ogFile
          ? await adminApi<{ branding: Branding }>(`/api/admin/branding/${t}/og-image`, { method: "PUT", file: ogFile.file })
          : await adminApi<{ branding: Branding }>(`/api/admin/branding/${t}/og-image`, { method: "DELETE" });
      if (!r.ok) {
        setSaving(false);
        if (latest) onSaved(latest, "제목·설명만 저장했어요");
        return setFailure(failMessage(r, "이미지를 저장하지 못했어요. 잠시 뒤 다시 시도해 주세요"));
      }
      latest = r.data.branding;
      setOgFile(null);
    }
    setSaving(false);
    if (latest) onSaved(latest, "공유 카드를 저장했어요");
  };

  const previewSrc =
    mode === "uploaded"
      ? (ogFile?.url ?? (branding.ogImage.uploaded ? branding.ogImage.url : null))
      : canEdit
        ? `/api/admin/branding/card-preview?title=${encodeURIComponent(previewTitle)}`
        : branding.ogImage.url;
  const host = typeof window === "undefined" ? "" : window.location.host;
  const shownDescription = description.trim() || branding.defaults.description;

  return (
    <div className="form-grid">
      <div className="col" style={{ gap: 20 }}>
        <section className="card pad col" style={{ gap: 14 }} aria-labelledby={`fav-${t}`}>
          <div className="col" style={{ gap: 4 }}>
            <h2 className="t-hl2" id={`fav-${t}`}>
              파비콘
            </h2>
            <span className="t-c1 c-alt">PNG·ICO 파일, 256KB까지 올릴 수 있어요. 512×512 같은 정사각형을 권장해요.</span>
          </div>
          <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <div className="row" style={{ gap: 12 }}>
              <span className="card row" style={{ width: 56, height: 56, justifyContent: "center", flex: "none" }}>
                {favicon || branding.favicon ? (
                  <img src={favicon?.url ?? branding.favicon!.url} alt="지금 파비콘" width={32} height={32} />
                ) : (
                  <span className="logo-sym" aria-label="기본 아이콘" />
                )}
              </span>
              <span className="col" style={{ gap: 2 }}>
                <span className="t-l1 fw6">{favicon ? "새 파비콘 미리보기" : branding.favicon ? "올린 파비콘" : "기본 아이콘"}</span>
                <span className="t-c1 c-alt">{favicon ? favicon.file.name : branding.favicon ? "브라우저 탭에 이 아이콘이 보여요" : "아직 올리지 않았어요"}</span>
              </span>
            </div>
            {canEdit && (
              <div className="row" style={{ gap: 8, marginLeft: "auto" }}>
                <input
                  ref={faviconInput}
                  type="file"
                  accept=".png,.ico,image/png,image/x-icon,image/vnd.microsoft.icon"
                  hidden
                  aria-label="파비콘 파일"
                  onChange={(e) => {
                    void pickFavicon(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
                {favicon ? (
                  <>
                    <button className="btn btn-sm btn-ghost" type="button" disabled={faviconBusy} onClick={() => setFavicon(null)}>
                      취소
                    </button>
                    <button className="btn btn-sm" type="button" disabled={faviconBusy} onClick={() => void uploadFavicon()}>
                      {faviconBusy ? "바꾸고 있어요" : "이 파비콘으로 바꾸기"}
                    </button>
                  </>
                ) : (
                  <>
                    {branding.favicon && (
                      <button className="btn btn-sm btn-ghost" type="button" disabled={faviconBusy} onClick={() => void resetFavicon()}>
                        기본값으로 되돌리기
                      </button>
                    )}
                    <button className="btn btn-sm" type="button" disabled={faviconBusy} onClick={() => faviconInput.current?.click()}>
                      파일 고르기
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {favicon?.warn && <span className="help">{favicon.warn}</span>}
          {faviconError && (
            <span className="err" role="alert">
              {faviconError}
            </span>
          )}
        </section>

        <section className="card pad col" style={{ gap: 16 }} aria-labelledby={`og-${t}`}>
          <div className="col" style={{ gap: 4 }}>
            <h2 className="t-hl2" id={`og-${t}`}>
              공유 카드
            </h2>
            <span className="t-c1 c-alt">메신저나 SNS에 주소를 붙여 넣으면 이 카드가 보여요.</span>
          </div>
          {failure && (
            <div className="msg msg-neg" role="alert">
              <span>
                <b>저장할 수 없어요.</b> {failure}
              </span>
            </div>
          )}
          <div className="fld">
            <label htmlFor={`title-${t}`}>제목</label>
            <input
              id={`title-${t}`}
              className={`inp${titleLen > TITLE_MAX ? " is-error" : ""}`}
              value={title}
              placeholder={branding.defaults.title}
              disabled={!canEdit}
              onChange={(e) => setTitle(e.target.value)}
            />
            <span className={titleLen > TITLE_MAX ? "err" : "help"}>
              {titleLen}/{TITLE_MAX} · 비우면 「{branding.defaults.title}」로 보여요
            </span>
          </div>
          <div className="fld">
            <label htmlFor={`desc-${t}`}>설명</label>
            <textarea
              id={`desc-${t}`}
              className={`inp${descLen > DESCRIPTION_MAX ? " is-error" : ""}`}
              value={description}
              placeholder={branding.defaults.description ?? "비워 두면 설명 없이 보여요"}
              disabled={!canEdit}
              onChange={(e) => setDescription(e.target.value)}
            />
            <span className={descLen > DESCRIPTION_MAX ? "err" : "help"}>
              {descLen}/{DESCRIPTION_MAX}
            </span>
          </div>
          <div className="col" style={{ gap: 8 }}>
            <span className="t-l2 fw6" id={`mode-${t}`}>
              카드 이미지
            </span>
            <span className="t-c1 c-alt">카드 이미지는 1200×630 크기예요. 직접 올릴 때는 이 크기 그대로 만들어 주세요.</span>
            <div className="seg" role="radiogroup" aria-labelledby={`mode-${t}`} style={{ alignSelf: "flex-start" }}>
              {(
                [
                  ["generated", "제목으로 만들기"],
                  ["uploaded", "이미지 올리기"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={mode === k}
                  className={mode === k ? "on" : ""}
                  disabled={!canEdit}
                  onClick={() => {
                    setMode(k);
                    setOgError(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {mode === "uploaded" && (
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="t-c1 c-alt">PNG·JPG, 2MB까지 올릴 수 있어요.</span>
                {canEdit && (
                  <>
                    <input
                      ref={ogInput}
                      type="file"
                      accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                      hidden
                      aria-label="공유 카드 이미지 파일"
                      onChange={(e) => {
                        void pickOg(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                    <button className="btn btn-sm" type="button" style={{ marginLeft: "auto" }} onClick={() => ogInput.current?.click()}>
                      {ogFile || branding.ogImage.uploaded ? "다른 이미지 고르기" : "이미지 고르기"}
                    </button>
                  </>
                )}
              </div>
            )}
            {ogError && (
              <span className="err" role="alert">
                {ogError}
              </span>
            )}
          </div>
        </section>
      </div>

      <aside className="col aside-sticky" style={{ gap: 16 }}>
        <div className="card col" style={{ overflow: "hidden" }} aria-label="공유 카드 미리보기">
          <span className="t-hl2" style={{ padding: "16px 16px 12px" }}>
            공유하면 이렇게 보여요
          </span>
          <div style={{ aspectRatio: "1200 / 630", background: "var(--wds-fill-normal)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            {previewSrc ? (
              <img src={previewSrc} alt="공유 카드 이미지 미리보기" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
            ) : (
              <span className="t-c1 c-alt">이미지를 골라 주세요</span>
            )}
          </div>
          <div className="col" style={{ gap: 4, padding: "12px 16px 16px" }}>
            <span className="t-c2 c-alt">{host}</span>
            <span className="t-l1 fw6 ell">{cardTitle}</span>
            {shownDescription && <span className="t-c1 c-alt">{shownDescription}</span>}
          </div>
        </div>
        {canEdit && (
          <button className="btn btn-lg btn-block" type="button" onClick={() => void save()} disabled={!canSave}>
            {saving ? "저장하고 있어요" : "공유 카드 저장"}
          </button>
        )}
      </aside>
    </div>
  );
}
