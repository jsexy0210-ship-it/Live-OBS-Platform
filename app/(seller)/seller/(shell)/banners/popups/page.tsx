"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { DateTimePicker } from "../../../../../../components/admin-ui/DatePicker";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../../components/seller/States";
import { EventPopupBar, EventPopupCard, type EventPopupItem } from "../../../../../../components/shop/EventPopup";
import { api } from "../../../../../../components/seller/api";
import LinkPicker, { linkSummary } from "../_shared/LinkPicker";
import {
  GripIcon,
  ImagePicker,
  StateBox,
  StatusBadge,
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
} from "../_shared/ui";

// SA-065 이벤트 팝업 관리(파트너스 관리자, 마케팅 › 이벤트 팝업). 정본 design/project/SA-065.dc.html: 팝업 표(팝업 / 형태 / 노출 페이지 / 기간 / 기기 / 상태 / 관리) →
// 같은 화면 아래 「팝업 수정」 입력 표 → 미리보기(모바일 홈) + 운영 규칙. 같은 화면에 여러 개가 걸리면 목록 순서대로 하나씩.
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
  const { can, me } = useSeller();
  const { confirm } = useConfirm();
  const editable = can("SHOP_SETTINGS");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; list: Popup[] }>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
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

  const remove = async (p: Popup) => {
    await confirm({
      title: "팝업을 삭제하시겠습니까?",
      body: `「${p.title}」를 삭제합니다. 쇼핑몰에서 바로 사라지고 되돌릴 수 없습니다.`,
      confirmLabel: "삭제",
      danger: true,
      run: async () => {
        const r = await api(`/api/seller/shop-content/popups/${p.id}`, { method: "DELETE" });
        if (!r.ok) return errorText(r, "삭제하지 못했습니다");
        setDraft((d) => (d?.id === p.id ? null : d));
        setToast({ text: "팝업을 삭제했습니다" });
        await load();
      },
    });
  };

  const n = (s: ContentStatus) => list.filter((p) => p.status === s).length;
  const current = draft ? list.find((p) => p.id === draft.id) : undefined;
  const others = list.filter((p) => p.status === "live" && p.id !== draft?.id);

  return (
    <>
      <Topbar crumb="마케팅 › 이벤트 팝업" />
      <main className="main">
        <PageHead
          title="이벤트 팝업"
          actions={
            state.kind === "ok" && editable ? (
              <button className="btn" type="button" disabled={list.length >= LIMIT} onClick={() => setDraft(empty)}>
                팝업 추가
              </button>
            ) : undefined
          }
        />
        {state.kind === "ok" && editable && list.length >= LIMIT && (
          <div className="msg msg-cau" role="status">
            <span>
              <b>팝업은 {LIMIT}개까지 등록할 수 있습니다.</b> 종료된 팝업을 삭제하거나 기간을 조정해 주십시오.
            </span>
          </div>
        )}
        {state.kind === "ok" && !editable && (
          <div className="msg msg-info" role="status">
            <span>목록만 볼 수 있습니다. 팝업 추가 · 수정은 대표자나 쇼핑몰 설정 권한이 있는 직원에게 요청해 주십시오.</span>
          </div>
        )}
        {state.kind === "loading" && <StateBox kind="loading" what="팝업" />}
        {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="팝업" onRetry={() => void load()} />}
        {state.kind === "ok" && list.length === 0 && (
          <section className="card" style={{ overflow: "hidden" }}>
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
          </section>
        )}
        {state.kind === "ok" && list.length > 0 && (
          <>
            <div className="sc-ltop">
              <span className="t-c1 c-alt" data-testid="popup-summary">
                팝업 {list.length}개{n("live") > 0 && ` · 게시 중 ${n("live")}`}
                {n("scheduled") > 0 && ` · 예약 ${n("scheduled")}`}
                {n("hidden") > 0 && ` · 숨김 ${n("hidden")}`}
                {n("ended") > 0 && ` · 종료 ${n("ended")}`}
              </span>
            </div>
            <div className="sc-tbl-wrap">
              <table className="tbl sc-tbl">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>팝업</th>
                    <th style={{ width: 150 }}>형태</th>
                    <th style={{ width: 100 }}>노출 페이지</th>
                    <th style={{ width: 190 }}>기간</th>
                    <th style={{ width: 90 }}>기기</th>
                    <th style={{ width: 70 }}>상태</th>
                    {editable && <th style={{ width: 150 }}>관리</th>}
                  </tr>
                </thead>
                <tbody>
                  {list.map((p, i) => (
                    <tr key={p.id} {...rowProps(p.id, editable)} data-testid="popup-row" className={draft?.id === p.id ? "is-sel" : undefined}>
                      <td className="col-text">
                        <span className="sc-ord">
                          {editable && (
                            <span className="sc-mv">
                              <button type="button" aria-label={`${p.title} 위로`} disabled={i === 0} onClick={() => move(i, i - 1)}>
                                ▲
                              </button>
                              <button type="button" aria-label={`${p.title} 아래로`} disabled={i === list.length - 1} onClick={() => move(i, i + 1)}>
                                ▼
                              </button>
                            </span>
                          )}
                          <span className="c-alt" aria-hidden="true">
                            <GripIcon />
                          </span>
                          <b className="ell">{p.title}</b>
                        </span>
                        <div className="t-c1 c-alt ell">{linkSummary(p.linkUrl)}</div>
                      </td>
                      <td>
                        {kindText(p.kind).label} · {kindText(p.kind).desc}
                      </td>
                      <td>{p.target === "HOME" ? "홈" : "전체 페이지"}</td>
                      <td className="num" style={{ whiteSpace: "nowrap" }}>
                        {periodText(p.startsAt, p.endsAt)}
                        <div className="t-c1 c-alt">{DISMISS.find((d) => d.v === p.dismissDays)?.label}</div>
                      </td>
                      <td>{devicesText(p)}</td>
                      <td>
                        <StatusBadge status={p.status} />
                      </td>
                      {editable && (
                        <td>
                          <div className="acts2">
                            <button className="btn btn-sm btn-out" type="button" onClick={() => setDraft(toDraft(p))}>
                              수정
                            </button>
                            <button className="btn btn-sm btn-out" type="button" onClick={() => setDraft({ ...toDraft(p), id: null, title: `${p.title} 복사본`.slice(0, 40), isActive: false })}>
                              복제
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <span className="t-c1 c-alt">같은 페이지에는 한 번에 1개씩 표시 · 우선순위는 목록 순서 · 상단 띠는 맨 위 1개만</span>
          </>
        )}
        {draft && (
          <PopupEditor
            key={draft.id ?? "new"}
            d={draft}
            setD={setDraft as (fn: (v: Draft) => Draft) => void}
            status={current?.status ?? null}
            overlap={draft.isActive && others.length > 0 ? others[0].title : null}
            onDelete={() => current && void remove(current)}
            onClose={() => setDraft(null)}
            onSaved={async (text) => {
              setDraft(null);
              setToast({ text });
              await load();
            }}
          />
        )}
        {state.kind === "ok" && (
          <div className="sc-two">
            <div>
              <div className="sc-sec-t">미리보기 · 모바일 홈</div>
              <PreviewFrame className="sc-pv-popup" data-testid="popup-preview" id="popup-preview">
                {draft ? <PopupPreview d={draft} slug={me.shop.slug} /> : <span className="t-c1 c-alt">팝업을 추가하거나 수정하면 여기에 표시됩니다</span>}
              </PreviewFrame>
              <span className="t-c1 c-alt">구매자 화면 문구는 해요체 그대로 표시 · 링크는 눌러도 이동하지 않음</span>
            </div>
            <div>
              <div className="sc-sec-t">운영 규칙</div>
              <table className="au-ft">
                <tbody>
                  <tr>
                    <th>동시 노출</th>
                    <td>페이지당 1개 · 목록 순서 우선 · 상단 띠는 맨 위 1개만</td>
                  </tr>
                  <tr>
                    <th>권한</th>
                    <td>대표자 · 쇼핑몰 설정 권한 직원</td>
                  </tr>
                  <tr>
                    <th>기록</th>
                    <td>추가 · 수정 · 숨김 · 삭제는 로그 추적에 남습니다</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

// 구매자 이벤트 팝업(EventPopup)의 띠·카드를 저장 전 입력값 그대로 그린다(모바일). 링크 버튼 문구가 비면 서버가 「자세히 보기」로 저장한다.
function PopupPreview({ d, slug }: { d: Draft; slug: string }) {
  const [hide, setHide] = useState(false);
  if (!d.showOnMobile) return <span className="t-c1 c-alt">모바일에서는 표시하지 않음</span>;
  const link = previewLink(slug, d.linkUrl);
  const item: EventPopupItem = {
    id: "preview",
    kind: d.kind,
    title: d.title,
    body: d.kind === "BAR" ? null : d.body.trim() || null,
    image: d.kind === "IMAGE" ? d.image : null,
    link,
    linkLabel: link && d.kind !== "BAR" ? d.linkLabel.trim() || "자세히 보기" : null,
    showOnPc: d.showOnPc,
    showOnMobile: d.showOnMobile,
    dismissDays: d.dismissDays,
    version: "preview",
  };
  return d.kind === "BAR" ? <EventPopupBar bar={item} onClose={() => undefined} /> : <EventPopupCard popup={item} hide={hide} onHide={setHide} onClose={() => undefined} />;
}

function PopupEditor({
  d,
  setD,
  status,
  overlap,
  onDelete,
  onClose,
  onSaved,
}: {
  d: Draft;
  setD: (fn: (v: Draft) => Draft) => void;
  status: ContentStatus | null;
  overlap: string | null;
  onDelete: () => void;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const { confirm } = useConfirm();
  const [failure, setFailure] = useState<string | null>(null);
  const { uploading, onBusy } = useUploading();
  const set = (patch: Partial<Draft>) => setD((v) => ({ ...v, ...patch }));
  const badRange = !!d.startsAt && !!d.endsAt && d.startsAt >= d.endsAt;
  const ready = d.title.trim() !== "" && (d.kind !== "IMAGE" || !!d.image) && (d.kind !== "TEXT" || d.body.trim() !== "") && linkLooksOk(d.linkUrl) && !badRange;

  const save = async () => {
    if (uploading || !ready) return;
    setFailure(null);
    await confirm({
      title: d.id ? "팝업을 저장하시겠습니까?" : "팝업을 추가하시겠습니까?",
      body: "쇼핑몰에 바로 반영됩니다.",
      confirmLabel: d.id ? "저장" : "추가",
      run: async () => {
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
        if (!r.ok) return errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오");
        onSaved(d.id ? "팝업을 저장했습니다" : "팝업을 추가했습니다");
      },
    });
  };

  return (
    <section aria-label={d.id ? "팝업 수정" : "팝업 추가"} data-testid="popup-editor">
      <div className="sc-sec-t">
        {d.id ? `팝업 수정 · ${d.title || "제목 없음"}` : "팝업 추가"}
        {status && (
          <span style={{ marginLeft: 8 }}>
            <StatusBadge status={status} />
          </span>
        )}
      </div>
      {failure && (
        <div className="msg msg-neg" role="alert">
          <span>{failure}</span>
        </div>
      )}
      {overlap && (
        <div className="msg msg-info" role="status">
          <span>같은 페이지에 게시 중인 팝업이 있습니다. 「{overlap}」가 먼저 표시되고, 이 팝업은 그 뒤에 표시됩니다 · 순서를 바꾸려면 목록에서 끌어 주십시오</span>
        </div>
      )}
      <table className="au-ft sc-ft">
        <tbody>
          <tr>
            <th>
              형태 <span className="sc-rq">*</span>
            </th>
            <td>
              {KINDS.map((k) => (
                <label key={k.key} className="sc-ck">
                  <input type="radio" name="popup-kind" checked={d.kind === k.key} onChange={() => set({ kind: k.key })} />
                  {k.label}
                </label>
              ))}
            </td>
          </tr>
          {d.kind === "IMAGE" && (
            <tr>
              <th>
                이미지 <span className="sc-rq">*</span>
              </th>
              <td>
                <ImagePicker
                  label="이미지"
                  recommend={{ width: 600, height: 600 }}
                  value={d.image}
                  onChange={(v) => set({ image: v })}
                  onBusy={onBusy}
                  frame={{ width: 180, height: 180, hint: "칸을 누르거나 파일을 끌어다 놓으면 올라갑니다" }}
                />
              </td>
            </tr>
          )}
          <tr>
            <th>
              <label htmlFor="popup-title">{d.kind === "IMAGE" ? "제목 (대체 텍스트)" : d.kind === "BAR" ? "띠 문구" : "제목"}</label> <span className="sc-rq">*</span>
            </th>
            <td>
              <input id="popup-title" className="inp" style={{ maxWidth: 360 }} value={d.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} />
              <span className="help">구매자에게 보이는 글 · 해요체 · 40자</span>
            </td>
          </tr>
          {d.kind !== "BAR" && (
            <tr>
              <th>
                <label htmlFor="popup-body">내용</label> {d.kind === "TEXT" && <span className="sc-rq">*</span>}
              </th>
              <td>
                <textarea id="popup-body" className="inp" style={{ maxWidth: 360, height: 88, padding: "10px 12px" }} value={d.body} maxLength={200} onChange={(e) => set({ body: e.target.value })} />
                <span className="help">구매자에게 보이는 글 · 해요체 · 200자{d.kind === "IMAGE" ? " · 비우면 이미지만" : ""}</span>
              </td>
            </tr>
          )}
          <tr>
            <th>
              <label htmlFor="banner-link-kind">버튼</label>
            </th>
            <td>
              <LinkPicker value={d.linkUrl} onChange={(v) => set({ linkUrl: v })} />
            </td>
          </tr>
          {d.kind !== "BAR" && d.linkUrl.trim() && (
            <tr>
              <th>
                <label htmlFor="popup-link-label">버튼 이름</label>
              </th>
              <td>
                <input id="popup-link-label" className="inp" style={{ maxWidth: 240 }} value={d.linkLabel} maxLength={20} placeholder="자세히 보기" onChange={(e) => set({ linkLabel: e.target.value })} />
                <span className="help">비우면 「자세히 보기」</span>
              </td>
            </tr>
          )}
          <tr>
            <th>
              <label htmlFor="popup-target">노출 페이지</label> <span className="sc-rq">*</span>
            </th>
            <td>
              <select id="popup-target" className="inp" style={{ maxWidth: 200 }} value={d.target} onChange={(e) => set({ target: e.target.value as Target })}>
                {TARGETS.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            </td>
          </tr>
          <tr>
            <th>표시 기기</th>
            <td>
              {(
                [
                  ["PC · 모바일", true, true],
                  ["PC만", true, false],
                  ["모바일만", false, true],
                ] as const
              ).map(([label, pc, mobile]) => (
                <label key={label} className="sc-ck">
                  <input type="radio" name="popup-device" checked={d.showOnPc === pc && d.showOnMobile === mobile} onChange={() => set({ showOnPc: pc, showOnMobile: mobile })} />
                  {label}
                </label>
              ))}
            </td>
          </tr>
          <tr>
            <th>게시 기간 (KST)</th>
            <td>
              <span className="sc-period">
                <DateTimePicker aria-label="시작 시각" value={d.startsAt} onChange={(v) => set({ startsAt: v })} />
                <span className="c-alt">~</span>
                <DateTimePicker aria-label="종료 시각" value={d.endsAt} onChange={(v) => set({ endsAt: v })} />
              </span>
              {badRange ? <span className="err">종료 시각은 시작 시각보다 늦어야 합니다</span> : <span className="help">비우면 바로 게시 · 종료를 비우면 상시 · 서버 시각 기준 자동 게시·숨김</span>}
            </td>
          </tr>
          <tr>
            <th>다시 보지 않기</th>
            <td>
              {DISMISS.map((x) => (
                <label key={x.v} className="sc-ck">
                  <input type="radio" name="popup-dismiss" checked={d.dismissDays === x.v} onChange={() => set({ dismissDays: x.v })} />
                  {x.label}
                </label>
              ))}
            </td>
          </tr>
          <tr>
            <th />
            <td>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <button className="btn" type="button" onClick={() => void save()} disabled={!ready || uploading}>
                  {uploading ? "이미지 올리는 중" : "저장"}
                </button>
                <button className="btn btn-out" type="button" onClick={() => document.getElementById("popup-preview")?.scrollIntoView({ block: "center" })}>
                  미리보기
                </button>
                <button className="btn btn-out" type="button" aria-pressed={!d.isActive} onClick={() => set({ isActive: !d.isActive })}>
                  {d.isActive ? "숨기기" : "숨김 해제"}
                </button>
                <button className="btn btn-out" type="button" onClick={onClose}>
                  닫기
                </button>
                {d.id && (
                  <button className="btn btn-neg" type="button" onClick={onDelete}>
                    팝업 삭제
                  </button>
                )}
              </div>
              {!d.isActive && <span className="help">숨김 상태로 저장되며 기간과 관계없이 표시되지 않습니다</span>}
              {!ready && <span className="help">{d.kind === "IMAGE" ? "이미지 · " : ""}제목{d.kind === "TEXT" ? " · 내용" : ""}을 채우면 저장할 수 있습니다</span>}
            </td>
          </tr>
        </tbody>
      </table>
    </section>
  );
}
