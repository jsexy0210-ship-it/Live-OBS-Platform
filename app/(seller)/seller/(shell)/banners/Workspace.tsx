"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useUnsavedGuard, confirmLeave } from "../../../../../lib/client/navigation/useUnsavedGuard";
import { detailHref, listReturnTo, setDetailResult, takeDetailResult } from "./_shared/detailNavigation";

import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, useConfirm } from "../../../../../components/admin-ui";
import { DatePicker } from "../../../../../components/admin-ui/DatePicker";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { Toast } from "../../../../../components/seller/States";
import HomeBanner from "../../../../../components/shop/HomeBanner";
import { api } from "../../../../../components/seller/api";
import { formatDate } from "../../../../../lib/client/format";
import LinkPicker, { linkSummary } from "./_shared/LinkPicker";
import {
  ImagePicker,
  StateBox,
  StatusBadge,
  devicesText,
  errorText,
  linkLooksOk,
  previewLink,
  PreviewFrame,
  stateKind,
  useSortable,
  useUploading,
  type AdminImage,
  type ContentStatus,
} from "./_shared/ui";

// SA-064 홈 배너 관리(파트너스 관리자, 마케팅 › 홈 배너). 정본 design/project/SA-064.dc.html: 배너 표(제목·연결 / 순서 / 이미지 / 게시 기간 / 기기 / 상태 / 관리) →
// 같은 화면 아래 「배너 수정」 입력 표 → 홈 미리보기(모바일) + 운영 규칙. 위쪽 오른쪽에 「자동 넘김」(끔·5초·8초).
// API: /api/seller/shop-content/banners(보기는 모든 직원, 바꾸기는 대표자·「쇼핑몰 설정」 권한 직원), 순서는 /reorder, 자동 넘김은 /interval.

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
type Devices = "both" | "pc" | "mobile";
type Draft = {
  id: string | null;
  title: string;
  pcImage: AdminImage | null;
  mobileImage: AdminImage | null;
  linkUrl: string;
  // 게시 기간은 날짜(KST)로 고른다. 시작은 그 날 0시, 끝은 그 날 끝(23:59:59)까지 게시한다.
  start: string;
  end: string;
  devices: Devices;
  isActive: boolean;
};

const LIMIT = 10;
const INTERVALS = [
  { v: 0, label: "끔" },
  { v: 5, label: "5초" },
  { v: 8, label: "8초" },
];
const empty: Draft = {
  id: null,
  title: "",
  pcImage: null,
  mobileImage: null,
  linkUrl: "",
  start: "",
  end: "",
  devices: "both",
  isActive: true,
};
const kstDay = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10) : "");
const toDevices = (b: { showOnPc: boolean; showOnMobile: boolean }): Devices => (b.showOnPc && b.showOnMobile ? "both" : b.showOnPc ? "pc" : "mobile");
const toDraft = (b: Banner): Draft => ({
  id: b.id,
  title: b.title,
  pcImage: b.pcImage,
  mobileImage: b.mobileImage,
  linkUrl: b.linkUrl ?? "",
  start: kstDay(b.startsAt),
  end: kstDay(b.endsAt),
  devices: toDevices(b),
  isActive: b.isActive,
});
const periodCell = (b: Banner) => {
  if (!b.startsAt && !b.endsAt) return "상시";
  return `${b.startsAt ? formatDate(b.startsAt) : ""} ~ ${b.endsAt ? formatDate(b.endsAt) : "상시"}`;
};

export default function Workspace({ view, itemId, copyId, returnTo }: { view?: "item" | "order"; itemId?: string; copyId?: string; returnTo?: string }) {
  const router = useRouter();
  const back = listReturnTo(returnTo, "/seller/banners");
  const generation = useRef(0);
  const initialized = useRef(false);
  const [orderBusy, setOrderBusy] = useState(false);
  const { can, me } = useSeller();
  const { confirm } = useConfirm();
  const editable = can("SHOP_SETTINGS");
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number; error?: string } | { kind: "ok"; list: Banner[]; intervalSec: number }>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  useEffect(() => { if (!view) { const text = takeDetailResult("/seller/banners"); if (text) setToast({ text }); } }, [view]);

  const load = useCallback(async () => {
    const current = ++generation.current;
    const r = await api<{ banners: Banner[]; intervalSec: number }>("/api/seller/shop-content/banners");
    if (current !== generation.current) return;
    if (!r.ok) return setState({ kind: "error", status: r.status, error: r.error });
    setState({
      kind: "ok",
      list: r.data.banners,
      intervalSec: r.data.intervalSec ?? 0,
    });
  }, []);

  useEffect(() => {
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const list = state.kind === "ok" ? state.list : [];
  useEffect(() => {
    if (state.kind !== "ok" || view !== "item" || initialized.current) return;
    initialized.current = true;
    const found = list.find((it) => it.id === (copyId || itemId));
    if (itemId !== "new" && !found || copyId && !found) return setState({ kind: "error", status: 404 });
    setDraft(itemId === "new" ? { ...empty } : toDraft(found!));
  }, [state, view, itemId, copyId, list]);
  const { move } = useSortable(list, async (next) => {
    if (orderBusy || !editable || view !== "order") return;
    setOrderBusy(true);
    setState((s) => (s.kind === "ok" ? { ...s, list: next } : s));
    const r = await api("/api/seller/shop-content/banners/reorder", {
      method: "PUT",
      body: { ids: next.map((b) => b.id) },
    });
    if (!r.ok) setToast({ text: errorText(r, "순서를 저장하지 못했습니다"), neg: true });
    else
      setToast({
        text: "순서를 저장했습니다 · 홈 슬라이드 순서가 바로 바뀝니다",
      });
    await load();
    setOrderBusy(false);
  });

  const remove = async (b: Banner) => {
    return confirm({
      title: "배너를 삭제하시겠습니까?",
      body: `「${b.title}」를 삭제합니다. 홈에서 바로 사라지고 되돌릴 수 없습니다.`,
      confirmLabel: "삭제",
      danger: true,
      run: async () => {
        const r = await api(`/api/seller/shop-content/banners/${b.id}`, {
          method: "DELETE",
        });
        if (!r.ok) return errorText(r, "삭제하지 못했습니다");
        if (!view) setDraft((d) => (d?.id === b.id ? null : d));
        setDetailResult("/seller/banners", "배너를 삭제했습니다");
        setToast({ text: "배너를 삭제했습니다" });
        if (!view) await load();
      },
    });
  };

  const changeInterval = async (v: number) => {
    const label = INTERVALS.find((i) => i.v === v)!.label;
    await confirm({
      title: v === 0 ? "자동 넘김을 끄시겠습니까?" : `자동 넘김을 ${label}로 바꾸시겠습니까?`,
      body: "쇼핑몰 홈 배너에 바로 반영됩니다.",
      confirmLabel: v === 0 ? "끄기" : "바꾸기",
      run: async () => {
        const r = await api("/api/seller/shop-content/banners/interval", {
          method: "PUT",
          body: { intervalSec: v },
        });
        if (!r.ok) return errorText(r, "자동 넘김을 바꾸지 못했습니다");
        setToast({ text: "자동 넘김을 바꿨습니다 · 홈에 바로 반영" });
        await load();
      },
    });
  };

  const n = (s: ContentStatus) => list.filter((b) => b.status === s).length;

  if (view) return <><Topbar crumb="마케팅 › 홈 배너 › 상세" /><main className="main">
    <PageHead title={view === "order" ? "노출 설정 상세" : itemId === "new" ? "배너 추가" : "배너 상세"} description="게시 내용과 조건을 확인한 뒤 저장합니다." back={back} actions={<Link className="btn btn-out" href={back}>목록</Link>} />
    {state.kind !== "ok" ? <StateBox kind={state.kind === "error" ? stateKind(state.status, state.error) : "loading"} what="배너" onRetry={() => void load()} /> : !editable ? <div className="msg msg-info">쇼핑몰 설정 권한이 필요합니다.</div> : view === "order" ? <section className="card pad col" style={{ gap: 12 }}>
      <span>전체 {list.length}개의 순서를 바꾸면 바로 반영됩니다.</span>
      {list.map((it, i) => <div className="row" key={it.id} style={{ gap: 8, flexWrap: "wrap" }}><span>{i + 1}. {it.title}</span><button className="btn btn-sm btn-out" aria-label={`${it.title} 위로`} disabled={orderBusy || i === 0} onClick={() => move(i, i - 1)}>▲</button><button className="btn btn-sm btn-out" aria-label={`${it.title} 아래로`} disabled={orderBusy || i === list.length - 1} onClick={() => move(i, i + 1)}>▼</button></div>)}
      <label>자동 넘김 <select className="inp" aria-label="자동 넘김" value={state.kind === "ok" ? state.intervalSec : 0} disabled={orderBusy} onChange={(e) => void changeInterval(Number(e.target.value))}>{INTERVALS.map((it) => <option key={it.v} value={it.v}>{it.label}</option>)}</select></label>
    </section> : draft ? <><BannerEditor key={draft.id ?? "new"} draft={draft} status={list.find((it) => it.id === draft.id)?.status ?? null} onDelete={async () => { const target = list.find((it) => it.id === draft.id); return target ? !!(await remove(target)) : false; }} onClose={() => router.push(back)} onSaved={(text) => { setDetailResult("/seller/banners", text); router.push(back); }} /></> : <StateBox kind="loading" what="상세" />}
    </main>{toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}</>;

  return (
    <>
      <Topbar crumb="마케팅 › 홈 배너" />
      <main className="main">
        <PageHead
          title="홈 배너"
          actions={
            <>
              <a className="btn btn-out" href={`/shop/${encodeURIComponent(me.shop.slug)}`} target="_blank" rel="noopener noreferrer">
                쇼핑몰 홈 보기
              </a>
              {state.kind === "ok" && editable && (
                <button className="btn" type="button" disabled={list.length >= LIMIT} onClick={() => router.push(detailHref("/seller/banners/new"))}>
                  배너 추가
                </button>
              )}
            </>
          }
        />
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
        {state.kind === "loading" && <StateBox kind="loading" what="배너" />}
        {state.kind === "error" && <StateBox kind={stateKind(state.status, state.error)} what="배너" onRetry={() => void load()} />}
        {state.kind === "ok" && list.length === 0 && (
          <section className="card" style={{ overflow: "hidden" }}>
            <div className="st" style={{ boxShadow: "none" }}>
              <div className="st-ic">+</div>
              <span className="t">등록한 배너가 없습니다</span>
              <span className="s">배너를 추가하면 쇼핑몰 홈 맨 위에 바로 표시됩니다</span>
              {editable && (
                <button className="btn btn-sm" type="button" onClick={() => router.push(detailHref("/seller/banners/new"))}>
                  배너 추가
                </button>
              )}
            </div>
          </section>
        )}
        {state.kind === "ok" && list.length > 0 && (
          <>
            <div className="sc-ltop">
              <span className="t-c1 c-alt" data-testid="banner-summary">
                배너 {list.length}장{n("live") > 0 && ` · 게시 중 ${n("live")}`}
                {n("scheduled") > 0 && ` · 예약 ${n("scheduled")}`}
                {n("hidden") > 0 && ` · 숨김 ${n("hidden")}`}
                {n("ended") > 0 && ` · 종료 ${n("ended")}`}
              </span>
              <button className="btn btn-out" type="button" onClick={() => router.push(detailHref("/seller/banners/order"))}>노출 설정 상세</button>
            </div>
            <div className="sc-tbl-wrap">
              <table className="tbl sc-tbl">
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>제목 · 연결</th>
                    <th style={{ width: 150 }}>순서</th>
                    <th style={{ width: 110 }}>이미지</th>
                    <th style={{ width: 170 }}>게시 기간</th>
                    <th style={{ width: 90 }}>기기</th>
                    <th style={{ width: 70 }}>상태</th>
                    {editable && <th style={{ width: 190 }}>관리</th>}
                  </tr>
                </thead>
                <tbody>
                  {list.map((b, i) => (
                    <tr key={b.id} data-testid="banner-row" className={draft?.id === b.id ? "is-sel" : undefined}>
                      <td className="col-text">
                        <b className="ell">{b.title}</b>
                        <div className="t-c1 c-alt ell">{linkSummary(b.linkUrl)}</div>
                      </td>
                      <td>
                        <div className="acts2" style={{ justifyContent: "center", alignItems: "center", gap: 6 }}>
                          <b className="num" style={{ minWidth: 14 }}>
                            {i + 1}
                          </b>

                        </div>
                      </td>
                      <td>
                        <img className="sc-thumb-sm" src={b.pcImage.url} alt="" />
                      </td>
                      <td className="num" style={{ whiteSpace: "nowrap" }}>
                        {periodCell(b)}
                      </td>
                      <td>{devicesText(b)}</td>
                      <td>
                        <StatusBadge status={b.status} />
                      </td>
                      {editable && (
                        <td>
                          <div className="acts2">
                            <button className="btn btn-sm btn-out" type="button" onClick={() => router.push(detailHref(`/seller/banners/${b.id}`))}>
                              수정
                            </button>
                            <button className="btn btn-sm btn-out" type="button" onClick={() => router.push(detailHref(`/seller/banners/${b.id}`))}>
                              삭제
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <span className="t-c1 c-alt">순서는 홈 슬라이드 순서와 같습니다 · 종료된 배너는 30일 뒤 자동 삭제</span>
          </>
        )}
        {state.kind === "ok" && (
          <div className="sc-two">
            <div>
              <div className="sc-sec-t">홈 미리보기 · 모바일</div>
              <PreviewFrame className="sc-box sc-banner-preview" data-testid="banner-home-preview">
                <HomeBanner
                  only="mobile"
                  intervalSec={0}
                  banners={list
                    .filter((b) => b.status === "live")
                    .map((b) => ({
                      id: b.id,
                      title: b.title,
                      link: null,
                      pcImage: b.pcImage,
                      mobileImage: b.mobileImage,
                      showOnPc: b.showOnPc,
                      showOnMobile: b.showOnMobile,
                    }))}
                />
                {list.every((b) => b.status !== "live") && <span className="t-c1 c-alt">지금 게시 중인 배너가 없습니다</span>}
                {list.some((b) => b.status === "live" && b.showOnMobile) && <span className="sc-box-n">1 / {list.filter((b) => b.status === "live" && b.showOnMobile).length}</span>}
              </PreviewFrame>
              <span className="t-c1 c-alt">회원 혜택 · 인기 카드 배너는 쇼핑몰 정보의 「홈 혜택 배너 보이기」로 따로 켭니다</span>
            </div>
            <div>
              <div className="sc-sec-t">운영 규칙</div>
              <table className="au-ft">
                <tbody>
                  <tr>
                    <th>노출 순서</th>
                    <td>위에서부터 · 목록의 ▲▼로 변경</td>
                  </tr>
                  <tr>
                    <th>게시 기간</th>
                    <td>시작 · 종료 시각 기준 자동 노출 · 종료 시 자동 숨김</td>
                  </tr>
                  <tr>
                    <th>권한</th>
                    <td>대표자 · 쇼핑몰 설정 권한 직원</td>
                  </tr>
                  <tr>
                    <th>기록</th>
                    <td>추가 · 수정 · 삭제는 로그 추적에 남습니다</td>
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

function BannerEditor({
  draft: initial,
  status,
  onDelete,
  onClose,
  onSaved,
}: {
  draft: Draft;
  status: ContentStatus | null;
  onDelete: () => Promise<boolean>;
  onClose: () => void;
  onSaved: (text: string) => void;
}) {
  const { me } = useSeller();
  const { confirm } = useConfirm();
  const [d, setD] = useState<Draft>(initial);
  const [failure, setFailure] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const { uploading, onBusy } = useUploading();
  const initialDraft = useRef(initial);
  const dirty = JSON.stringify(d) !== JSON.stringify(initialDraft.current);
  const release = useUnsavedGuard(dirty || uploading);
  const close = async () => { if (!uploading && confirmLeave(dirty)) { await release(); onClose(); } };
  const remove = async () => { if (await onDelete()) { await release(); onClose(); } };
  const set = (patch: Partial<Draft>) => setD((v) => ({ ...v, ...patch }));
  const link = d.linkUrl;
  const badRange = !!d.start && !!d.end && d.start > d.end;
  const ready = d.title.trim() !== "" && !!d.pcImage && !!d.start && linkLooksOk(link) && !badRange;

  const save = async () => {
    if (uploading || !ready || !d.pcImage) return;
    const pc = d.pcImage;
    setFailure(null);
    await confirm({
      title: d.id ? "배너를 저장하시겠습니까?" : "배너를 추가하시겠습니까?",
      body: "쇼핑몰 홈에 바로 반영됩니다.",
      confirmLabel: d.id ? "저장" : "추가",
      run: async () => {
        const body = {
          title: d.title,
          pcImageId: pc.id,
          mobileImageId: d.mobileImage?.id ?? null,
          linkUrl: link.trim() || null,
          startsAt: `${d.start}T00:00:00+09:00`,
          endsAt: d.end ? `${d.end}T23:59:59+09:00` : null,
          showOnPc: d.devices !== "mobile",
          showOnMobile: d.devices !== "pc",
          isActive: d.isActive,
        };
        const r = d.id
          ? await api(`/api/seller/shop-content/banners/${d.id}`, {
              method: "PUT",
              body,
            })
          : await api("/api/seller/shop-content/banners", {
              method: "POST",
              body,
            });
        if (!r.ok) return errorText(r, "저장하지 못했습니다. 잠시 뒤 다시 시도해 주십시오");
        await release();
        onSaved(d.id ? "배너를 저장했습니다 · 홈에 바로 반영" : "배너를 추가했습니다 · 홈에 바로 반영");
      },
    });
  };

  const previewItem = d.pcImage
    ? [
        {
          id: "preview",
          title: d.title,
          link: previewLink(me.shop.slug, link),
          pcImage: d.pcImage,
          mobileImage: d.mobileImage,
          showOnPc: d.devices !== "mobile",
          showOnMobile: d.devices !== "pc",
        },
      ]
    : [];

  return (
    <section aria-label={d.id ? "배너 수정" : "배너 추가"} data-testid="banner-editor">
      <div className="sc-sec-t">
        {d.id ? `배너 수정 · ${initial.title}` : "배너 추가"}
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
      <table className="au-ft sc-ft">
        <tbody>
          <tr>
            <th>
              PC 이미지 <span className="sc-rq">*</span>
            </th>
            <td>
              <ImagePicker
                label="PC 이미지"
                recommend={{ width: 1200, height: 400 }}
                value={d.pcImage}
                onChange={(v) => set({ pcImage: v })}
                onBusy={onBusy}
                frame={{
                  width: 300,
                  height: 100,
                  hint: "칸을 누르거나 파일을 끌어다 놓으면 올라갑니다",
                }}
              />
            </td>
          </tr>
          <tr>
            <th>모바일 이미지</th>
            <td>
              <ImagePicker
                optional
                label="모바일 이미지"
                recommend={{ width: 750, height: 750 }}
                value={d.mobileImage}
                onChange={(v) => set({ mobileImage: v })}
                onBusy={onBusy}
                frame={{
                  width: 150,
                  height: 150,
                  hint: "비우면 PC 이미지를 맞춰서 표시",
                }}
              />
            </td>
          </tr>
          <tr>
            <th>
              <label htmlFor="banner-title">제목 (대체 텍스트)</label> <span className="sc-rq">*</span>
            </th>
            <td>
              <input id="banner-title" className="inp" style={{ maxWidth: 360 }} value={d.title} maxLength={40} onChange={(e) => set({ title: e.target.value })} />
              <span className="help">화면 낭독기와 이미지가 안 뜰 때 표시 · 40자</span>
            </td>
          </tr>
          <tr>
            <th>
              <label htmlFor="banner-link-kind">연결</label>
            </th>
            <td>
              <LinkPicker value={d.linkUrl} onChange={(v) => set({ linkUrl: v })} />
            </td>
          </tr>
          <tr>
            <th>
              게시 기간 <span className="sc-rq">*</span>
            </th>
            <td>
              <span className="sc-period">
                <DatePicker className="dt-sm" aria-label="게시 시작일" value={d.start} onChange={(v) => set({ start: v })} max={d.end || undefined} />
                <span className="c-alt">~</span>
                <DatePicker className="dt-sm" aria-label="게시 종료일" value={d.end} onChange={(v) => set({ end: v })} min={d.start || undefined} />
              </span>
              <label className="sc-ck">
                <input type="checkbox" checked={d.end === ""} onChange={(e) => set({ end: e.target.checked ? "" : d.start })} />
                상시
              </label>
              {badRange ? <span className="err">종료일은 시작일보다 빠를 수 없습니다</span> : <span className="help">종료일을 비우면 상시</span>}
            </td>
          </tr>
          <tr>
            <th>표시 기기</th>
            <td>
              {(
                [
                  ["both", "PC · 모바일"],
                  ["pc", "PC만"],
                  ["mobile", "모바일만"],
                ] as const
              ).map(([k, label]) => (
                <label key={k} className="sc-ck">
                  <input type="radio" name="banner-device" checked={d.devices === k} onChange={() => set({ devices: k })} />
                  {label}
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
                <button className="btn btn-out" type="button" onClick={() => setPreviewing((v) => !v)} aria-pressed={previewing}>
                  미리보기
                </button>
                <button className="btn btn-out" type="button" onClick={() => void close()} disabled={uploading}>
                  닫기
                </button>
                {d.id && (
                  <button className="btn btn-neg" type="button" onClick={() => void remove()} disabled={uploading}>
                    배너 삭제
                  </button>
                )}
              </div>
              {!ready && <span className="help">이미지 · 제목 · 게시 시작일을 채우면 저장할 수 있습니다</span>}
            </td>
          </tr>
        </tbody>
      </table>
      {previewing && (
        <PreviewFrame className="sc-box sc-banner-preview" data-testid="banner-preview">
          {d.devices === "pc" ? (
            <span className="t-c1 c-alt">모바일에서는 표시하지 않음</span>
          ) : previewItem.length > 0 ? (
            <HomeBanner banners={previewItem} only="mobile" intervalSec={0} />
          ) : (
            <span className="t-c1 c-alt">PC 이미지를 올리면 여기에 표시됩니다</span>
          )}
        </PreviewFrame>
      )}
    </section>
  );
}
