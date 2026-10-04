"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { cleanText, textLength, type TextKind } from "../../../../../../lib/server/text/clean";

// SA-060 공유 미리보기: 쇼핑몰 주소를 공유할 때 보이는 제목·설명. 비워 두면 제목은 쇼핑몰 이름, 설명은 없음.
// 카드 이미지는 서버가 쇼핑몰 이름으로 그린 기본 카드(/api/shop/{slug}/og.png)다(이미지·파비콘 올리기는 이미지 저장소를 정한 뒤).
// API: GET·PUT /api/seller/share-preview(대표자·쇼핑몰 설정 권한). 서버와 같은 길이 제한(lib/server/shop/sharePreview.ts).
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

type Preview = { title: string | null; description: string | null };

// 서버(sharePreview.ts field)와 같은 기준: NFKC 뒤 글자 수, 그리고 cleanText가 받지 않는 글자(줄바꿈·제어 문자 등)
const len = textLength;
function problem(v: string, max: number, kind: TextKind): string | null {
  if (v.trim() === "" || cleanText(v, max, kind) !== null) return null;
  if (textLength(v) > max) return `${max}자까지 입력할 수 있습니다`;
  return /[\r\n]/.test(v) ? "줄바꿈 없이 입력해 주십시오" : "사용할 수 없는 문자가 있습니다";
}

export default function ShareSettingsPage() {
  const { me } = useSeller();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: Preview }>({ kind: "loading" });
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.host), []);

  const apply = (p: Preview) => {
    setTitle(p.title ?? "");
    setDescription(p.description ?? "");
  };

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ preview: Preview }>("/api/seller/share-preview");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    apply(r.data.preview);
    setState({ kind: "ok", saved: r.data.preview });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saved = state.kind === "ok" ? state.saved : null;
  const dirty = !!saved && ((saved.title ?? "") !== title || (saved.description ?? "") !== description);
  const titleProblem = problem(title, TITLE_MAX, "name");
  const descriptionProblem = problem(description, DESCRIPTION_MAX, "memo");
  const tooLong = titleProblem !== null || descriptionProblem !== null;

  const save = async () => {
    if (!saved || tooLong) return;
    setSaving(true);
    setFailure(null);
    const r = await api<{ preview: Preview }>("/api/seller/share-preview", {
      method: "PUT",
      body: { title: title.trim() || null, description: description.trim() || null },
    });
    setSaving(false);
    if (!r.ok) return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    apply(r.data.preview);
    setState({ kind: "ok", saved: r.data.preview });
    setToast("공유 미리보기를 저장했습니다");
  };

  const shownTitle = cleanText(title, TITLE_MAX, "name") ?? me.shop.name;
  const shownDescription = cleanText(description, DESCRIPTION_MAX, "memo") ?? "";

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 공유 미리보기">
        {saved && (
          <button className="btn btn-sm" type="button" onClick={() => void save()} disabled={saving || !dirty || tooLong}>
            {saving ? "저장 중" : "저장"}
          </button>
        )}
      </Topbar>
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">공유 미리보기</h1>
            <span className="t-l2 c-alt">쇼핑몰 주소를 메신저나 검색에 공유할 때 표시되는 제목과 설명을 설정합니다.</span>
          </div>
        </div>

        {state.kind !== "ok" ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={3} />}
            {state.kind === "error" &&
              (state.status === 403 ? (
                <NoPermission need="쇼핑몰 설정" />
              ) : state.status === 402 ? (
                <Locked />
              ) : (
                <ErrorState title="공유 미리보기를 불러오지 못했습니다" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="form-grid">
            {/* 저장하는 동안은 칸을 잠근다: 보낸 값과 다른 수정이 응답으로 덮이지 않게 */}
            <fieldset className="col settings-fields" style={{ gap: 20 }} disabled={saving}>
              {failure && (
                <div className="msg msg-neg" role="alert">
                  <span>
                    <b>저장할 수 없습니다.</b> {failure}
                  </span>
                </div>
              )}
              <section className="card pad col" style={{ gap: 14 }}>
                <h2 className="t-hl2">제목 · 설명</h2>
                <div className="fld">
                  <label htmlFor="sp-title">제목</label>
                  <input
                    id="sp-title"
                    className={`inp${titleProblem ? " is-error" : ""}`}
                    value={title}
                    placeholder={me.shop.name}
                    onChange={(e) => setTitle(e.target.value)}
                    aria-describedby="sp-title-help"
                    aria-invalid={!!titleProblem}
                  />
                  <span id="sp-title-help" className="row between t-c1 c-alt">
                    <span className={titleProblem ? "c-neg" : undefined}>{titleProblem ?? "비워 두면 쇼핑몰 이름을 사용합니다"}</span>
                    <span className={len(title) > TITLE_MAX ? "c-neg" : undefined}>
                      {len(title)}/{TITLE_MAX}
                    </span>
                  </span>
                </div>
                <div className="fld">
                  <label htmlFor="sp-description">설명</label>
                  <textarea
                    id="sp-description"
                    className={`inp${descriptionProblem ? " is-error" : ""}`}
                    rows={3}
                    value={description}
                    placeholder="예: 매주 금요일 밤 라이브로 만나요"
                    onChange={(e) => setDescription(e.target.value)}
                    aria-describedby="sp-description-help"
                    aria-invalid={!!descriptionProblem}
                  />
                  <span id="sp-description-help" className="row between t-c1 c-alt">
                    <span className={descriptionProblem ? "c-neg" : undefined}>{descriptionProblem ?? "비워 두면 설명 없이 표시됩니다"}</span>
                    <span className={len(description) > DESCRIPTION_MAX ? "c-neg" : undefined}>
                      {len(description)}/{DESCRIPTION_MAX}
                    </span>
                  </span>
                </div>
              </section>
              <section className="card pad col" style={{ gap: 12 }}>
                <h2 className="t-hl2">공유 화면 미리보기</h2>
                <div className="sp-card" data-testid="sp-card">
                  <img className="sp-card-img" src={`/api/shop/${encodeURIComponent(me.shop.slug)}/og.png`} alt="" width={1200} height={630} />
                  <div className="sp-card-body col">
                    <span className="sp-card-title">{shownTitle}</span>
                    {shownDescription && <span className="sp-card-desc">{shownDescription}</span>}
                    <span className="sp-card-host">{host}</span>
                  </div>
                </div>
              </section>
            </fieldset>
            <aside className="col aside-sticky" style={{ gap: 16 }}>
              <div className="card pad col" style={{ gap: 8 }}>
                <span className="t-hl2">참고</span>
                <span className="t-c1 c-alt" style={{ lineHeight: 1.6 }}>
                  상품 화면을 공유하면 상품 이름이 제목으로 먼저 표시됩니다. 공유한 곳에서 미리보기를 잠시 저장해 두므로 변경 내용이 늦게 반영될 수 있습니다. 카드 이미지는 쇼핑몰 이름으로 만듭니다.
                </span>
              </div>
              <button className="btn btn-lg btn-block" type="button" onClick={() => void save()} disabled={saving || !dirty || tooLong}>
                {saving ? "저장 중" : "저장"}
              </button>
            </aside>
          </div>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
