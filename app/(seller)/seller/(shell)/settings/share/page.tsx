"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { SettingsTabs } from "../../../../../../components/seller/SettingsTabs";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";

// SA-060 공유 미리보기: 쇼핑몰 주소를 공유할 때 보이는 제목·설명. 비워 두면 제목은 쇼핑몰 이름, 설명은 없음.
// 카드 이미지는 서버가 쇼핑몰 이름으로 그린 기본 카드(/api/shop/{slug}/og.png)다(이미지·파비콘 올리기는 이미지 저장소를 정한 뒤).
// API: GET·PUT /api/seller/share-preview(대표자·쇼핑몰 설정 권한). 서버와 같은 길이 제한(lib/server/shop/sharePreview.ts).
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 160;

type Preview = { title: string | null; description: string | null };

// 서버와 같은 길이 세기(코드포인트)
const len = (v: string) => Array.from(v).length;

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
  const tooLong = len(title.trim()) > TITLE_MAX || len(description.trim()) > DESCRIPTION_MAX;

  const save = async () => {
    if (!saved || tooLong) return;
    setSaving(true);
    setFailure(null);
    const r = await api<{ preview: Preview }>("/api/seller/share-preview", {
      method: "PUT",
      body: { title: title.trim() || null, description: description.trim() || null },
    });
    setSaving(false);
    if (!r.ok) return setFailure(failMessage(r, "저장하지 못했어요. 잠시 뒤 다시 시도해 주세요"));
    apply(r.data.preview);
    setState({ kind: "ok", saved: r.data.preview });
    setToast("공유 미리보기를 저장했어요");
  };

  const shownTitle = title.trim() || me.shop.name;
  const shownDescription = description.trim();

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 공유 미리보기">
        {saved && (
          <button className="btn btn-sm" type="button" onClick={() => void save()} disabled={saving || !dirty || tooLong}>
            {saving ? "저장하고 있어요" : "저장"}
          </button>
        )}
      </Topbar>
      <main className="main">
        <SettingsTabs />
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">공유 미리보기</h1>
            <span className="t-l2 c-alt">쇼핑몰 주소를 메신저나 검색에 공유할 때 보이는 제목과 설명을 정해요.</span>
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
                <ErrorState title="공유 미리보기를 불러오지 못했어요" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="form-grid">
            <div className="col" style={{ gap: 20 }}>
              {failure && (
                <div className="msg msg-neg" role="alert">
                  <span>
                    <b>저장할 수 없어요.</b> {failure}
                  </span>
                </div>
              )}
              <section className="card pad col" style={{ gap: 14 }}>
                <h2 className="t-hl2">제목 · 설명</h2>
                <div className="fld">
                  <label htmlFor="sp-title">제목</label>
                  <input
                    id="sp-title"
                    className={`inp${len(title.trim()) > TITLE_MAX ? " is-error" : ""}`}
                    value={title}
                    placeholder={me.shop.name}
                    onChange={(e) => setTitle(e.target.value)}
                    aria-describedby="sp-title-help"
                    aria-invalid={len(title.trim()) > TITLE_MAX}
                  />
                  <span id="sp-title-help" className="row between t-c1 c-alt">
                    <span>비워 두면 쇼핑몰 이름을 써요</span>
                    <span className={len(title.trim()) > TITLE_MAX ? "c-neg" : undefined}>
                      {len(title.trim())}/{TITLE_MAX}
                    </span>
                  </span>
                </div>
                <div className="fld">
                  <label htmlFor="sp-description">설명</label>
                  <textarea
                    id="sp-description"
                    className={`inp${len(description.trim()) > DESCRIPTION_MAX ? " is-error" : ""}`}
                    rows={3}
                    value={description}
                    placeholder="예: 매주 금요일 밤 라이브로 만나요"
                    onChange={(e) => setDescription(e.target.value)}
                    aria-describedby="sp-description-help"
                    aria-invalid={len(description.trim()) > DESCRIPTION_MAX}
                  />
                  <span id="sp-description-help" className="row between t-c1 c-alt">
                    <span>비워 두면 설명 없이 보여요</span>
                    <span className={len(description.trim()) > DESCRIPTION_MAX ? "c-neg" : undefined}>
                      {len(description.trim())}/{DESCRIPTION_MAX}
                    </span>
                  </span>
                </div>
              </section>
              <section className="card pad col" style={{ gap: 12 }}>
                <h2 className="t-hl2">공유하면 이렇게 보여요</h2>
                <div className="sp-card" data-testid="sp-card">
                  <img className="sp-card-img" src={`/api/shop/${encodeURIComponent(me.shop.slug)}/og.png`} alt="" width={1200} height={630} />
                  <div className="sp-card-body col">
                    <span className="sp-card-title">{shownTitle}</span>
                    {shownDescription && <span className="sp-card-desc">{shownDescription}</span>}
                    <span className="sp-card-host">{host}</span>
                  </div>
                </div>
              </section>
            </div>
            <aside className="col aside-sticky" style={{ gap: 16 }}>
              <div className="card pad col" style={{ gap: 8 }}>
                <span className="t-hl2">알아 두세요</span>
                <span className="t-c1 c-alt" style={{ lineHeight: 1.6 }}>
                  상품 화면을 공유하면 상품 이름이 제목으로 먼저 보여요. 공유한 곳에서는 미리보기를 잠시 저장해 두어서, 바꾼 내용이 늦게 보일 수 있어요. 카드 이미지는 쇼핑몰 이름으로 만들어요.
                </span>
              </div>
              <button className="btn btn-lg btn-block" type="button" onClick={() => void save()} disabled={saving || !dirty || tooLong}>
                {saving ? "저장하고 있어요" : "저장"}
              </button>
            </aside>
          </div>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
