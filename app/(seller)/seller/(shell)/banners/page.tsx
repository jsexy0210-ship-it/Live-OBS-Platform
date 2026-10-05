"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import HomeBanner from "../../../../../components/shop/HomeBanner";
import { api } from "../../../../../components/seller/api";
import {
  ConfirmDelete,
  ContentTabs,
  DeviceSeg,
  GripIcon,
  ImagePicker,
  LinkField,
  PeriodFields,
  StateBox,
  StatusBadge,
  StatusSummary,
  devicesText,
  errorText,
  fromKstInput,
  linkLooksOk,
  periodText,
  previewLink,
  PreviewFrame,
  stateKind,
  toKstInput,
  useSortable,
  useUploading,
  type AdminImage,
  type ContentStatus,
} from "./_shared/ui";
import { Modal } from "../../../../../components/admin-ui";

// SA-064 홈 배너 관리(파트너스 관리자, 설정 › 배너 · 팝업). 쇼핑몰 홈 맨 위 슬라이드. 끌어서 순서 변경, PC·모바일 이미지,
// 링크, 게시 기간, 표시 기기, 미리보기. API: /api/seller/shop-content/banners(보기는 모든 직원, 바꾸기는 대표자·「쇼핑몰 설정」 권한 직원).

type Banner = {
  id: string;
  title: string;
  pcImage: AdminImage;
  mobileImage: AdminImage | null;
  linkUrl: string | null;
  startsAt: string | null;
  endsAt: string | null;
  showOnPc: boolean;
  showOnMobile: boolean;
  isActive: boolean;
  sortOrder: number;
  status: ContentStatus;
};
type Draft = {
  id: string | null;
  title: string;
  pcImage: AdminImage | null;
  mobileImage: AdminImage | null;
  linkUrl: string;
  startsAt: string;
  endsAt: string;
  showOnPc: boolean;
  showOnMobile: boolean;
  isActive: boolean;
};

const LIMIT = 10;
const empty: Draft = { id: null, title: "", pcImage: null, mobileImage: null, linkUrl: "", startsAt: "", endsAt: "", showOnPc: true, showOnMobile: true, isActive: true };
const toDraft = (b: Banner): Draft => ({
  id: b.id,
  title: b.title,
  pcImage: b.pcImage,
  mobileImage: b.mobileImage,
  linkUrl: b.linkUrl ?? "",
  startsAt: toKstInput(b.startsAt),
  endsAt: toKstInput(b.endsAt),
  showOnPc: b.showOnPc,
  showOnMobile: b.showOnMobile,
  isActive: b.isActive,
});

export default function BannersPage() {
  const { can, me } = useSeller();
  const editable = can("SHOP_SETTINGS");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; list: Banner[] }>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Banner | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ banners: Banner[] }>("/api/seller/shop-content/banners");
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", list: r.data.banners });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const list = state.kind === "ok" ? state.list : [];
  const { rowProps, move } = useSortable(list, async (next) => {
    setState({ kind: "ok", list: next });
    const r = await api("/api/seller/shop-content/banners/reorder", { method: "PUT", body: { ids: next.map((b) => b.id) } });
    if (!r.ok) setToast({ text: errorText(r, "순서를 저장하지 못했습니다"), neg: true });
    else setToast({ text: "순서를 저장했습니다" });
    await load();
  });

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    const r = await api(`/api/seller/shop-content/banners/${deleting.id}`, { method: "DELETE" });
    setBusy(false);
    setDeleting(null);
    setToast(r.ok ? { text: "배너를 삭제했습니다" } : { text: errorText(r, "삭제하지 못했습니다"), neg: true });
    await load();
  };

  return (
    <>
      <Topbar crumb="설정 › 배너 · 팝업 › 홈 배너" />
      <main className="main">
        <ContentTabs active="banners" />
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">홈 배너 관리</h1>
            <span className="t-l2 c-alt">쇼핑몰 홈 맨 위 슬라이드 · 순서를 끌어서 바꾸고 기간 · 링크 · 기기별 이미지를 지정 · 최대 {LIMIT}장</span>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <a className="btn btn-out" href={`/shop/${encodeURIComponent(me.shop.slug)}`} target="_blank" rel="noopener noreferrer">
              쇼핑몰 홈 보기
            </a>
            {state.kind === "ok" && editable && (
              <button className="btn" type="button" disabled={list.length >= LIMIT} onClick={() => setDraft(empty)}>
                배너 추가
              </button>
            )}
          </div>
        </div>
        {state.kind === "ok" && editable && list.length >= LIMIT && (
          <div className="msg msg-cau" role="status">
            <span>
              <b>배너는 {LIMIT}장까지 등록할 수 있습니다.</b> 종료된 배너를 삭제하거나 기간을 조정해 주십시오.
            </span>
          </div>
        )}
        {state.kind === "ok" && !editable && (
          <div className="msg msg-info" role="status">
            <span>목록만 볼 수 있습니다. 배너 추가 · 수정은 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        <section className="card" style={{ overflow: "hidden" }}>
          {state.kind === "loading" && <StateBox kind="loading" what="배너" />}
          {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="배너" onRetry={() => void load()} />}
          {state.kind === "ok" && list.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">+</div>
              <span className="t">등록한 배너가 없습니다</span>
              <span className="s">배너를 추가하면 쇼핑몰 홈 맨 위에 바로 표시됩니다</span>
              {editable && (
                <button className="btn btn-sm" type="button" onClick={() => setDraft(empty)}>
                  배너 추가
                </button>
              )}
            </div>
          )}
          {state.kind === "ok" && list.length > 0 && <StatusSummary noun="배너" unit="장" list={list} />}
          {state.kind === "ok" && list.length > 0 && (
            <ol className="sc-list" aria-label="배너 순서" style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {list.map((b, i) => (
                <li key={b.id} className="sc-row" {...rowProps(b.id, editable)} data-testid="banner-row">
                  <span className="sc-grip" title={editable ? "끌어서 순서 변경" : undefined}>
                    {editable && (
                      <button type="button" aria-label={`${b.title} 위로`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                        ▲
                      </button>
                    )}
                    <GripIcon />
                    {editable && (
                      <button type="button" aria-label={`${b.title} 아래로`} disabled={i === list.length - 1} onClick={() => move(i, i + 1)}>
                        ▼
                      </button>
                    )}
                  </span>
                  <img className="sc-thumb" src={b.pcImage.url} alt="" />
                  <span className="sc-meta">
                    <span className="row" style={{ gap: 8 }}>
                      <StatusBadge status={b.status} />
                      <span className="t-l1 fw6 ell">{b.title}</span>
                    </span>
                    <span className="t-c1 c-alt num">
                      {periodText(b.startsAt, b.endsAt)} · {devicesText(b)}
                    </span>
                    <span className="t-c1 c-alt ell">
                      {b.linkUrl ? `연결 ${b.linkUrl}` : "연결 없음"} · {b.mobileImage ? "모바일 이미지 따로" : "모바일도 PC 이미지"}
                    </span>
                  </span>
                  {editable && (
                    <span className="sc-acts">
                      <button className="btn btn-sm btn-out" type="button" onClick={() => setDraft(toDraft(b))}>
                        수정
                      </button>
                      <button className="btn btn-sm btn-text" type="button" style={{ color: "var(--neg-text)" }} onClick={() => setDeleting(b)}>
                        삭제
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
        {state.kind === "ok" && list.length > 0 && <span className="t-c1 c-alt">순서는 홈 슬라이드 순서와 같음 · 시작 시각에 자동 게시, 종료 시각이 지나면 자동 숨김</span>}
      </main>
      {draft && (
        <BannerEditor
          draft={draft}
          onClose={() => setDraft(null)}
          onSaved={async (text) => {
            setDraft(null);
            setToast({ text });
            await load();
          }}
        />
      )}
      {deleting && (
        <ConfirmDelete title="배너를 삭제하시겠습니까?" body={`「${deleting.title}」를 삭제합니다. 홈에서 바로 사라지고 되돌릴 수 없습니다.`} busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void remove()} />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

function BannerEditor({ draft: initial, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: (text: string) => void }) {
  const { me } = useSeller();
  const [d, setD] = useState<Draft>(initial);
  const [device, setDevice] = useState<"pc" | "mobile">("pc");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const { uploading, onBusy } = useUploading();
  const set = (patch: Partial<Draft>) => setD((v) => ({ ...v, ...patch }));
  const ready = d.title.trim() !== "" && !!d.pcImage && linkLooksOk(d.linkUrl) && !(d.startsAt && d.endsAt && d.startsAt >= d.endsAt);

  const save = async () => {
    if (uploading || !ready || !d.pcImage) return;
    setSaving(true);
    setFailure(null);
    const body = {
      title: d.title,
      pcImageId: d.pcImage.id,
      mobileImageId: d.mobileImage?.id ?? null,
      linkUrl: d.linkUrl.trim() || null,
      startsAt: fromKstInput(d.startsAt),
      endsAt: fromKstInput(d.endsAt),
      showOnPc: d.showOnPc,
      showOnMobile: d.showOnMobile,
      isActive: d.isActive,
    };
    const r = d.id
      ? await api(`/api/seller/shop-content/banners/${d.id}`, { method: "PUT", body })
      : await api("/api/seller/shop-content/banners", { method: "POST", body });
    setSaving(false);
    if (!r.ok) return setFailure(errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
    onSaved(d.id ? "배너를 저장했습니다 · 홈에 바로 반영" : "배너를 추가했습니다 · 홈에 바로 반영");
  };

  // 구매자 홈 배너(HomeBanner)를 저장 전 입력값 그대로 그린다: 이미지·제목(대체 글)·링크·표시 기기
  const previewItem = d.pcImage ? [{ id: "preview", title: d.title, link: previewLink(me.shop.slug, d.linkUrl), pcImage: d.pcImage, mobileImage: d.mobileImage, showOnPc: d.showOnPc, showOnMobile: d.showOnMobile }] : [];
  const previewShown = previewItem.length > 0 && (device === "pc" ? d.showOnPc : d.showOnMobile);

  return (
    <Modal labelId="banner-edit-title" className="modal-xl sc-modal" busy={saving} onClose={onClose}>
      <div className="modal-h">
        <h2 className="t-h2" id="banner-edit-title">
          {d.id ? "배너 수정" : "배너 추가"}
        </h2>
      </div>
      {failure && (
        <div className="msg msg-neg" role="alert">
          <span>
            <b>저장할 수 없습니다.</b> {failure}
          </span>
        </div>
      )}
      <div className="sc-edit">
        <div className="col" style={{ gap: 16 }}>
          <div className="fld">
            <label htmlFor="banner-title" className="req">
              제목 (대체 텍스트)
            </label>
            <input id="banner-title" className="inp" value={d.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} placeholder="예: 10월 신상품 오픈" />
            <span className="help">화면 낭독기와 이미지가 안 뜰 때 표시 · 40자</span>
          </div>
          <ImagePicker onBusy={onBusy} label="PC 이미지" recommend={{ width: 1920, height: 600 }} value={d.pcImage} onChange={(v) => set({ pcImage: v })} />
          <ImagePicker onBusy={onBusy}
            label="모바일 이미지"
            optional
            recommend={{ width: 750, height: 750 }}
            emptyHint="비우면 PC 이미지를 맞춰서 표시"
            value={d.mobileImage}
            onChange={(v) => set({ mobileImage: v })}
          />
          <LinkField value={d.linkUrl} onChange={(v) => set({ linkUrl: v })} />
          <PeriodFields startsAt={d.startsAt} endsAt={d.endsAt} onChange={(v) => set(v)} />
          <DeviceSeg value={d} onChange={(v) => set(v)} />
          <div className="row between">
            <span className="col" style={{ gap: 2 }}>
              <span className="t-l1 fw6" id="banner-active-label">
                노출
              </span>
              <span className="t-c1 c-alt">끄면 기간과 관계없이 숨김</span>
            </span>
            <button className={`sw${d.isActive ? " on" : ""}`} type="button" role="switch" aria-checked={d.isActive} aria-labelledby="banner-active-label" onClick={() => set({ isActive: !d.isActive })} />
          </div>
        </div>
        <div className="sc-preview">
          <div className="row between">
            <span className="t-hl2">미리보기</span>
            <div className="seg" role="radiogroup" aria-label="미리보기 기기">
              {(["pc", "mobile"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={device === k} className={device === k ? "on" : ""} onClick={() => setDevice(k)}>
                  {k === "pc" ? "PC" : "모바일"}
                </button>
              ))}
            </div>
          </div>
          <div className={`sc-preview-stage is-${device}`} data-testid="banner-preview">
            {previewShown ? (
              <PreviewFrame>
                <HomeBanner banners={previewItem} only={device} />
              </PreviewFrame>
            ) : (
              <span className="t-c1 c-alt" style={{ alignSelf: "center" }}>
                {previewItem.length === 0 ? "이미지를 올리면 여기에 표시됩니다" : `${device === "pc" ? "PC" : "모바일"}에서는 표시하지 않음`}
              </span>
            )}
          </div>
          <span className="help">실제 쇼핑몰 홈 맨 위에 이 모양으로 표시됩니다 · 링크는 눌러도 이동하지 않음</span>
        </div>
      </div>
      <div className="modal-f">
        <button className="btn btn-out" type="button" onClick={onClose} disabled={saving}>
          취소
        </button>
        <button className="btn" type="button" onClick={() => void save()} disabled={!ready || saving || uploading}>
          {saving ? "저장 중" : uploading ? "이미지 올리는 중" : "저장"}
        </button>
      </div>
    </Modal>
  );
}
