"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
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
  stateKind,
  toKstInput,
  useSortable,
  useUploading,
  type AdminImage,
  type ContentStatus,
} from "../_shared/ui";

// SA-065 이벤트 팝업 관리(파트너스 관리자, 설정 › 배너 · 팝업). 형태(이미지 팝업·글 팝업·상단 띠), 기간, 노출 페이지(홈·전체),
// 표시 기기, 「보지 않기」(오늘 하루·7일·닫기만), 미리보기, 노출 순서, 복제. 같은 화면에 여러 개가 걸리면 목록 순서대로 하나씩.
// API: /api/seller/shop-content/popups.

type Kind = "IMAGE" | "TEXT" | "BAR";
type Target = "HOME" | "ALL";
type Popup = {
  id: string;
  kind: Kind;
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
  dismissDays: number;
  isActive: boolean;
  sortOrder: number;
  status: ContentStatus;
};
type Draft = {
  id: string | null;
  kind: Kind;
  title: string;
  body: string;
  image: AdminImage | null;
  linkUrl: string;
  linkLabel: string;
  startsAt: string;
  endsAt: string;
  target: Target;
  showOnPc: boolean;
  showOnMobile: boolean;
  dismissDays: number;
  isActive: boolean;
};

const LIMIT = 20;
const KINDS: { key: Kind; label: string; desc: string }[] = [
  { key: "IMAGE", label: "이미지 팝업", desc: "가운데" },
  { key: "TEXT", label: "글 팝업", desc: "가운데" },
  { key: "BAR", label: "상단 띠", desc: "맨 위 한 줄" },
];
const TARGETS: { key: Target; label: string }[] = [
  { key: "HOME", label: "홈" },
  { key: "ALL", label: "전체 페이지" },
];
const DISMISS: { v: number; label: string }[] = [
  { v: 1, label: "오늘 하루 보지 않기" },
  { v: 7, label: "7일 동안 보지 않기" },
  { v: 0, label: "닫기만 (매번 표시)" },
];
const empty: Draft = {
  id: null,
  kind: "IMAGE",
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
  dismissDays: 1,
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
const kindText = (k: Kind) => KINDS.find((x) => x.key === k)!;

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
      <Topbar crumb="설정 › 배너 · 팝업 › 이벤트 팝업" />
      <main className="main">
        <ContentTabs active="popups" />
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">이벤트 팝업 관리</h1>
            <span className="t-l2 c-alt">쇼핑몰 방문자에게 띄우는 안내 · 이벤트 팝업 · 기간 · 노출 페이지 · 기기 · 「오늘 하루 보지 않기」 제어</span>
          </div>
          {state.kind === "ok" && editable && (
            <button className="btn" type="button" disabled={list.length >= LIMIT} onClick={() => setDraft(empty)}>
              팝업 추가
            </button>
          )}
        </div>
        {state.kind === "ok" && !editable && (
          <div className="msg msg-info" role="status">
            <span>목록만 볼 수 있습니다. 팝업 추가 · 수정은 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        <section className="card" style={{ overflow: "hidden" }}>
          {state.kind === "loading" && <StateBox kind="loading" what="팝업" />}
          {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="팝업" onRetry={() => void load()} />}
          {state.kind === "ok" && list.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">+</div>
              <span className="t">등록한 팝업이 없습니다</span>
              <span className="s">방송 예고 · 배송 안내 · 이벤트를 팝업으로 알릴 수 있습니다</span>
              {editable && (
                <button className="btn btn-sm" type="button" onClick={() => setDraft(empty)}>
                  팝업 추가
                </button>
              )}
            </div>
          )}
          {state.kind === "ok" && list.length > 0 && <StatusSummary noun="팝업" unit="개" list={list} />}
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
                  {p.image ? <img className="sc-thumb" src={p.image.url} alt="" /> : <span className="sc-thumb t-c1">{kindText(p.kind).label}</span>}
                  <span className="sc-meta">
                    <span className="row" style={{ gap: 8 }}>
                      <StatusBadge status={p.status} />
                      <span className="t-l1 fw6 ell">{p.title}</span>
                    </span>
                    <span className="t-c1 c-alt">
                      {kindText(p.kind).label} · {kindText(p.kind).desc} · {p.target === "HOME" ? "홈" : "전체 페이지"} · {devicesText(p)}
                    </span>
                    <span className="t-c1 c-alt num ell">
                      {periodText(p.startsAt, p.endsAt)} · {DISMISS.find((d) => d.v === p.dismissDays)?.label}
                    </span>
                  </span>
                  {editable && (
                    <span className="sc-acts">
                      <button className="btn btn-sm btn-out" type="button" onClick={() => setDraft(toDraft(p))}>
                        수정
                      </button>
                      <button className="btn btn-sm btn-out" type="button" onClick={() => setDraft({ ...toDraft(p), id: null, title: `${p.title} 복사본`.slice(0, 40), isActive: false })}>
                        복제
                      </button>
                      <button className="btn btn-sm btn-text" type="button" style={{ color: "var(--neg-text)" }} onClick={() => setDeleting(p)}>
                        삭제
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>
        {state.kind === "ok" && list.length > 0 && <span className="t-c1 c-alt">같은 페이지에는 한 번에 1개씩 표시 · 우선순위는 목록 순서 · 상단 띠는 맨 위 1개만</span>}
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
        <ConfirmDelete title="팝업을 삭제하시겠습니까?" body={`「${deleting.title}」를 삭제합니다. 쇼핑몰에서 바로 사라지고 되돌릴 수 없습니다.`} busy={busy} onCancel={() => setDeleting(null)} onConfirm={() => void remove()} />
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
  const { uploading, onBusy } = useUploading();
  const set = (patch: Partial<Draft>) => setD((v) => ({ ...v, ...patch }));
  const ready =
    d.title.trim() !== "" &&
    (d.kind !== "IMAGE" || !!d.image) &&
    (d.kind !== "TEXT" || d.body.trim() !== "") &&
    linkLooksOk(d.linkUrl) &&
    !(d.startsAt && d.endsAt && d.startsAt >= d.endsAt);

  const save = async () => {
    if (uploading || !ready) return;
    setSaving(true);
    setFailure(null);
    const body = {
      kind: d.kind,
      title: d.title,
      body: d.kind === "BAR" ? null : d.body.trim() || null,
      imageId: d.kind === "IMAGE" ? (d.image?.id ?? null) : null,
      linkUrl: d.linkUrl.trim() || null,
      linkLabel: d.kind === "BAR" ? null : d.linkLabel.trim() || null,
      startsAt: fromKstInput(d.startsAt),
      endsAt: fromKstInput(d.endsAt),
      target: d.target,
      showOnPc: d.showOnPc,
      showOnMobile: d.showOnMobile,
      dismissDays: d.dismissDays,
      isActive: d.isActive,
    };
    const r = d.id ? await api(`/api/seller/shop-content/popups/${d.id}`, { method: "PUT", body }) : await api("/api/seller/shop-content/popups", { method: "POST", body });
    setSaving(false);
    if (!r.ok) return setFailure(errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오"));
    onSaved(d.id ? "팝업을 저장했습니다" : "팝업을 추가했습니다");
  };

  const shown = device === "pc" ? d.showOnPc : d.showOnMobile;
  const dismissText = DISMISS.find((x) => x.v === d.dismissDays)!;

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
              <span className="lbl req" id="popup-kind-label">
                형태
              </span>
              <div className="seg" role="radiogroup" aria-labelledby="popup-kind-label" style={{ alignSelf: "flex-start" }}>
                {KINDS.map((k) => (
                  <button key={k.key} type="button" role="radio" aria-checked={d.kind === k.key} className={d.kind === k.key ? "on" : ""} onClick={() => set({ kind: k.key })}>
                    {k.label}
                  </button>
                ))}
              </div>
            </div>
            {d.kind === "IMAGE" && <ImagePicker onBusy={onBusy} label="이미지" recommend={{ width: 600, height: 600 }} value={d.image} onChange={(v) => set({ image: v })} />}
            <div className="fld">
              <label htmlFor="popup-title" className="req">
                {d.kind === "IMAGE" ? "제목 (대체 텍스트)" : d.kind === "BAR" ? "띠 문구" : "제목"}
              </label>
              <input id="popup-title" className="inp" value={d.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} placeholder="예: 10/4 토 20시 스타라이트 브레이크" />
              <span className="help">구매자에게 보이는 글 · 해요체 · 40자</span>
            </div>
            {d.kind !== "BAR" && (
              <div className="fld">
                <label htmlFor="popup-body" className={d.kind === "TEXT" ? "req" : undefined}>
                  내용
                </label>
                <textarea id="popup-body" className="inp" style={{ height: 88, padding: "10px 12px" }} value={d.body} maxLength={200} onChange={(e) => set({ body: e.target.value })} />
                <span className="help">구매자에게 보이는 글 · 해요체 · 200자{d.kind === "IMAGE" ? " · 비우면 이미지만" : ""}</span>
              </div>
            )}
            <LinkField value={d.linkUrl} onChange={(v) => set({ linkUrl: v })} />
            {d.kind !== "BAR" && d.linkUrl.trim() && (
              <div className="fld">
                <label htmlFor="popup-link-label">버튼 이름</label>
                <input id="popup-link-label" className="inp" value={d.linkLabel} maxLength={20} placeholder="자세히 보기" onChange={(e) => set({ linkLabel: e.target.value })} />
                <span className="help">비우면 「자세히 보기」</span>
              </div>
            )}
            <PeriodFields startsAt={d.startsAt} endsAt={d.endsAt} onChange={(v) => set(v)} />
            <div className="sc-two">
              <div className="fld">
                <label htmlFor="popup-target">노출 페이지</label>
                <select id="popup-target" className="inp" value={d.target} onChange={(e) => set({ target: e.target.value as Target })}>
                  {TARGETS.map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="fld">
                <label htmlFor="popup-dismiss">다시 보지 않기</label>
                <select id="popup-dismiss" className="inp" value={d.dismissDays} onChange={(e) => set({ dismissDays: Number(e.target.value) })}>
                  {DISMISS.map((x) => (
                    <option key={x.v} value={x.v}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <DeviceSeg value={d} onChange={(v) => set(v)} />
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
              {!shown ? (
                <span className="t-c1 c-alt" style={{ alignSelf: "center" }}>
                  {device === "pc" ? "PC" : "모바일"}에서는 표시하지 않음
                </span>
              ) : d.kind === "BAR" ? (
                <div className="sc-pv-bar">
                  <span className="t-l2 fw6">{d.title || "띠 문구"}</span>
                  <span>×</span>
                </div>
              ) : (
                <div className="sc-pv-popup">
                  <div className="ep-card">
                    {d.kind === "IMAGE" && d.image && <img src={d.image.url} alt="" />}
                    <div className="col" style={{ gap: 8, padding: "12px 12px 4px" }}>
                      {d.kind === "TEXT" && <span className="t-l1 fw7">{d.title || "제목"}</span>}
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
                      <span>{d.dismissDays > 0 ? dismissText.label : ""}</span>
                      <span>닫기</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
            <span className="help">구매자 화면 문구는 해요체 그대로 표시</span>
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
      </div>
    </div>
  );
}
