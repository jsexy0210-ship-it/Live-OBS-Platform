"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import {
  ConfirmDelete,
  GripIcon,
  ImagePicker,
  LinkField,
  PeriodFields,
  StateBox,
  StatusBadge,
  errorText,
  fromKstInput,
  linkLooksOk,
  periodText,
  stateKind,
  toKstInput,
  useSortable,
  type AdminImage,
  type ContentStatus,
} from "../banners/_shared/ui";

// 이벤트 팝업 관리(파트너스 관리자). 노출 기간, 노출 화면(홈만·모든 화면), PC·모바일, 「오늘 하루 보지 않기」 허용, 미리보기, 노출 순서.
// 같은 화면에 여러 팝업이 걸리면 위에서부터 하나씩 차례로 보여 준다. API: /api/seller/shop-content/popups.

type Target = "HOME" | "ALL";
type Popup = {
  id: string;
  title: string;
  body: string | null;
  image: AdminImage | null;
  linkUrl: string | null;
  linkLabel: string | null;
  startsAt: string | null;
  endsAt: string | null;
  target: Target;
  showOnPc: boolean;
  showOnMobile: boolean;
  allowHideToday: boolean;
  isActive: boolean;
  sortOrder: number;
  status: ContentStatus;
};
type Draft = Omit<Popup, "sortOrder" | "status" | "id" | "body" | "linkUrl" | "linkLabel" | "startsAt" | "endsAt"> & {
  id: string | null;
  body: string;
  linkUrl: string;
  linkLabel: string;
  startsAt: string;
  endsAt: string;
};

const LIMIT = 20;
const TARGETS: { key: Target; label: string }[] = [
  { key: "HOME", label: "쇼핑몰 홈만" },
  { key: "ALL", label: "모든 화면" },
];
const empty: Draft = {
  id: null,
  title: "",
  body: "",
  image: null,
  linkUrl: "",
  linkLabel: "",
  startsAt: "",
  endsAt: "",
  target: "HOME",
  showOnPc: true,
  showOnMobile: true,
  allowHideToday: true,
  isActive: true,
};
const toDraft = (p: Popup): Draft => ({
  ...p,
  body: p.body ?? "",
  linkUrl: p.linkUrl ?? "",
  linkLabel: p.linkLabel ?? "",
  startsAt: toKstInput(p.startsAt),
  endsAt: toKstInput(p.endsAt),
});
const devicesText = (p: { showOnPc: boolean; showOnMobile: boolean }) => (p.showOnPc && p.showOnMobile ? "PC · 모바일" : p.showOnPc ? "PC만" : "모바일만");

export default function PopupsPage() {
  const { can } = useSeller();
  const editable = can("SHOP_SETTINGS");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; list: Popup[] }>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<Popup | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await api<{ popups: Popup[] }>("/api/seller/shop-content/popups");
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({ kind: "ok", list: r.data.popups });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const list = state.kind === "ok" ? state.list : [];
  const { rowProps, move } = useSortable(list, async (next) => {
    setState({ kind: "ok", list: next });
    const r = await api("/api/seller/shop-content/popups/reorder", { method: "PUT", body: { ids: next.map((p) => p.id) } });
    if (!r.ok) setToast({ text: errorText(r, "순서를 저장하지 못했습니다"), neg: true });
    else setToast({ text: "순서를 저장했습니다" });
    await load();
  });

  const remove = async () => {
    if (!deleting) return;
    setBusy(true);
    const r = await api(`/api/seller/shop-content/popups/${deleting.id}`, { method: "DELETE" });
    setBusy(false);
    setDeleting(null);
    setToast(r.ok ? { text: "팝업을 삭제했습니다" } : { text: errorText(r, "삭제하지 못했습니다"), neg: true });
    await load();
  };

  return (
    <>
      <Topbar crumb="설정 › 이벤트 팝업 관리">
        {state.kind === "ok" && editable && (
          <button className="btn btn-sm" type="button" disabled={list.length >= LIMIT} onClick={() => setDraft(empty)}>
            팝업 추가
          </button>
        )}
      </Topbar>
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">이벤트 팝업 관리</h1>
            <span className="t-l2 c-alt">구매자가 쇼핑몰에 들어오면 가운데에 노출 · 여러 개면 위에서부터 하나씩 · 최대 {LIMIT}개</span>
          </div>
        </div>
        <section className="card" style={{ overflow: "hidden" }}>
          {state.kind === "loading" && <StateBox kind="loading" what="팝업" />}
          {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="팝업" onRetry={() => void load()} />}
          {state.kind === "ok" && list.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <span className="t">등록된 팝업 없음</span>
              <span className="s">이벤트·공지를 팝업으로 알릴 수 있습니다</span>
              {editable && (
                <button className="btn btn-sm" type="button" onClick={() => setDraft(empty)}>
                  팝업 추가
                </button>
              )}
            </div>
          )}
          {state.kind === "ok" && list.length > 0 && (
            <ol className="sc-list" aria-label="팝업 순서" style={{ margin: 0, padding: 0, listStyle: "none" }}>
              {list.map((p, i) => (
                <li key={p.id} className="sc-row" {...rowProps(p.id, editable)} data-testid="popup-row">
                  <span className="sc-grip" title={editable ? "끌어서 순서 변경" : undefined}>
                    {editable && (
                      <button type="button" aria-label={`${p.title} 위로`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                        ▲
                      </button>
                    )}
                    <GripIcon />
                    {editable && (
                      <button type="button" aria-label={`${p.title} 아래로`} disabled={i === list.length - 1} onClick={() => move(i, i + 1)}>
                        ▼
                      </button>
                    )}
                  </span>
                  {p.image ? <img className="sc-thumb" src={p.image.url} alt="" /> : <span className="sc-thumb t-c1">글만</span>}
                  <span className="sc-meta">
                    <span className="row" style={{ gap: 8 }}>
                      <StatusBadge status={p.status} />
                      <span className="t-l1 fw6 ell">{p.title}</span>
                    </span>
                    <span className="t-c1 c-alt num">{periodText(p.startsAt, p.endsAt)}</span>
                    <span className="t-c1 c-alt ell">
                      {p.target === "HOME" ? "쇼핑몰 홈만" : "모든 화면"} · {devicesText(p)} · {p.allowHideToday ? "오늘 하루 보지 않기 허용" : "오늘 하루 보지 않기 없음"}
                    </span>
                  </span>
                  {editable && (
                    <span className="sc-acts">
                      <button className="btn btn-sm btn-out" type="button" onClick={() => setDraft(toDraft(p))}>
                        수정
                      </button>
                      <button className="btn btn-sm btn-ghost" type="button" onClick={() => setDeleting(p)}>
                        삭제
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
      </main>
      {draft && (
        <PopupEditor
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
        <ConfirmDelete title="팝업을 삭제하시겠습니까?" body={`「${deleting.title}」 팝업이 쇼핑몰에서 바로 사라집니다.`} busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void remove()} />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

function PopupEditor({ draft: initial, onClose, onSaved }: { draft: Draft; onClose: () => void; onSaved: (text: string) => void }) {
  const [d, setD] = useState<Draft>(initial);
  const [device, setDevice] = useState<"pc" | "mobile">("pc");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD((v) => ({ ...v, ...patch }));
  const ready =
    d.title.trim() !== "" && linkLooksOk(d.linkUrl) && (d.showOnPc || d.showOnMobile) && !(d.startsAt && d.endsAt && d.startsAt >= d.endsAt);

  const save = async () => {
    if (!ready) return;
    setSaving(true);
    setFailure(null);
    const body = {
      title: d.title,
      body: d.body.trim() || null,
      imageId: d.image?.id ?? null,
      linkUrl: d.linkUrl.trim() || null,
      linkLabel: d.linkLabel.trim() || null,
      startsAt: fromKstInput(d.startsAt),
      endsAt: fromKstInput(d.endsAt),
      target: d.target,
      showOnPc: d.showOnPc,
      showOnMobile: d.showOnMobile,
      allowHideToday: d.allowHideToday,
      isActive: d.isActive,
    };
    const r = d.id ? await api(`/api/seller/shop-content/popups/${d.id}`, { method: "PUT", body }) : await api("/api/seller/shop-content/popups", { method: "POST", body });
    setSaving(false);
    if (!r.ok) return setFailure(errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
    onSaved(d.id ? "팝업을 저장했습니다" : "팝업을 추가했습니다");
  };

  const shown = device === "pc" ? d.showOnPc : d.showOnMobile;

  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="popup-edit-title">
      <div className="modal modal-xl sc-modal">
        <div className="modal-h">
          <h2 className="t-h2" id="popup-edit-title">
            {d.id ? "팝업 수정" : "팝업 추가"}
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
              <label htmlFor="popup-title" className="req">
                제목
              </label>
              <input id="popup-title" className="inp" value={d.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} placeholder="예: 10/4 토 20시 스타라이트 브레이크" />
              <span className="help">팝업에 굵게 노출 · 40자까지</span>
            </div>
            <div className="fld">
              <label htmlFor="popup-body">내용</label>
              <textarea id="popup-body" className="inp" style={{ height: 88, padding: "10px 12px" }} value={d.body} maxLength={200} onChange={(e) => set({ body: e.target.value })} />
              <span className="help">200자까지 · 비워 두면 제목만 노출</span>
            </div>
            <ImagePicker label="이미지" optional hint="PNG·JPEG · 3MB까지 · 권장 가로 800px" value={d.image} onChange={(v) => set({ image: v })} />
            <LinkField value={d.linkUrl} onChange={(v) => set({ linkUrl: v })} />
            {d.linkUrl.trim() && (
              <div className="fld">
                <label htmlFor="popup-link-label">버튼 이름</label>
                <input id="popup-link-label" className="inp" value={d.linkLabel} maxLength={20} placeholder="자세히 보기" onChange={(e) => set({ linkLabel: e.target.value })} />
                <span className="help">비워 두면 「자세히 보기」</span>
              </div>
            )}
            <PeriodFields startsAt={d.startsAt} endsAt={d.endsAt} onChange={(v) => set(v)} />
            <div className="fld">
              <span className="lbl" id="popup-target-label">
                노출 화면
              </span>
              <div className="seg" role="radiogroup" aria-labelledby="popup-target-label" style={{ alignSelf: "flex-start" }}>
                {TARGETS.map((t) => (
                  <button key={t.key} type="button" role="radio" aria-checked={d.target === t.key} className={d.target === t.key ? "on" : ""} onClick={() => set({ target: t.key })}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="fld">
              <span className="lbl">노출 기기</span>
              <div className="sc-checks">
                <label className="chk">
                  <input className="cbx" type="checkbox" checked={d.showOnPc} onChange={(e) => set({ showOnPc: e.target.checked })} />
                  PC
                </label>
                <label className="chk">
                  <input className="cbx" type="checkbox" checked={d.showOnMobile} onChange={(e) => set({ showOnMobile: e.target.checked })} />
                  모바일
                </label>
              </div>
              {!d.showOnPc && !d.showOnMobile && <span className="err">PC·모바일 중 하나 이상 선택해 주십시오</span>}
            </div>
            <div className="row between">
              <span className="col" style={{ gap: 2 }}>
                <span className="t-l1 fw6" id="popup-hide-label">
                  「오늘 하루 보지 않기」 허용
                </span>
                <span className="t-c1 c-alt">구매자 브라우저에 저장 · 다음 날 다시 노출</span>
              </span>
              <button className={`sw${d.allowHideToday ? " on" : ""}`} type="button" role="switch" aria-checked={d.allowHideToday} aria-labelledby="popup-hide-label" onClick={() => set({ allowHideToday: !d.allowHideToday })} />
            </div>
            <div className="row between">
              <span className="col" style={{ gap: 2 }}>
                <span className="t-l1 fw6" id="popup-active-label">
                  노출
                </span>
                <span className="t-c1 c-alt">끄면 기간과 관계없이 숨김</span>
              </span>
              <button className={`sw${d.isActive ? " on" : ""}`} type="button" role="switch" aria-checked={d.isActive} aria-labelledby="popup-active-label" onClick={() => set({ isActive: !d.isActive })} />
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
            <div className={`sc-preview-stage is-${device}`} data-testid="popup-preview">
              {shown ? (
                <div className="sc-pv-popup">
                  <div className="ep-card">
                    {d.image && <img src={d.image.url} alt="" />}
                    <div className="col" style={{ gap: 8, padding: "12px 12px 4px" }}>
                      <span className="t-l1 fw7">{d.title || "제목"}</span>
                      {d.body.trim() && (
                        <span className="t-c1 c-alt" style={{ whiteSpace: "pre-line" }}>
                          {d.body}
                        </span>
                      )}
                      {d.linkUrl.trim() && (
                        <span className="btn btn-sm btn-block" aria-hidden="true">
                          {d.linkLabel.trim() || "자세히 보기"}
                        </span>
                      )}
                    </div>
                    <div className="row between t-c1 c-alt" style={{ padding: "8px 12px" }}>
                      <span>{d.allowHideToday ? "오늘 하루 보지 않기" : ""}</span>
                      <span>닫기</span>
                    </div>
                  </div>
                </div>
              ) : (
                <span className="t-c1 c-alt" style={{ alignSelf: "center" }}>
                  {device === "pc" ? "PC" : "모바일"}에서는 노출되지 않음
                </span>
              )}
            </div>
            <span className="help">구매자 화면에서는 「오늘 하루 보지 않기」·「닫기」 문구가 그대로 노출됩니다</span>
          </div>
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={saving}>
            취소
          </button>
          <button className="btn" type="button" onClick={() => void save()} disabled={!ready || saving}>
            {saving ? "저장 중" : "저장"}
          </button>
        </div>
      </div>
    </div>
  );
}
