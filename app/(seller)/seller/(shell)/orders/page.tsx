"use client";

import { formatDateTimeParts } from "../../../../../lib/client/format";
import "../../../../../styles/seller-orders.css";
import Link from "next/link";
import { CursorPagination } from "../../../../../components/Pagination";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import { ListTable, Modal, PageHead } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { MAX_SEARCH_LENGTH, textLength, won } from "../../../../../components/seller/format";
import { STATUS_BADGE, itemSummaryText, kstDaysAgo, payBadge, type OrderRow, type OrderStatus } from "../../../../../components/seller/orders";

// SA-021 판매자 주문 목록. 서버 커서로 10건씩 조회하며 방문한 페이지로 돌아간다(GET /api/seller/orders).
// 환불할 수 있는 주문(refundable)만 「환불 처리」 버튼이 있고, 발송 여부(shipped)는 「배송」 열에 따로 보인다.
const PAGE = 10;
const SEARCH_DELAY_MS = 300;
const STATUSES: OrderStatus[] = ["PENDING_PAYMENT", "PAID", "CANCELLED", "REFUNDED"];
type Period = "today" | "7d" | "30d";
const PERIODS: { key: Period; label: string; days: number }[] = [
  { key: "today", label: "오늘", days: 0 },
  { key: "7d", label: "최근 7일", days: 6 },
  { key: "30d", label: "최근 30일", days: 29 },
];
type Shipped = "true" | "false";
// 상태 칩(정본 SA-021-OPS): 서버 필터·건수(GET /api/seller/orders/counts)와 같은 기준. warn은 정본에서 건수를 빨간색으로 보이는 칩
type Counts = { total: number; today: number; unpaid: number; trackingMissing: number; queueWaiting: number; queueDone: number; queueDonePending: number; refundRequested: number };
const NO: Record<string, string> = { status: "", shipped: "", queue: "", prepared: "", refundRequested: "", trackingMissing: "" };
const CHIPS = [
  { key: "today", label: "오늘", count: "today", warn: false, set: { ...NO, period: "today" } },
  { key: "unpaid", label: "입금 전", count: "unpaid", warn: true, set: { ...NO, period: "all", status: "PENDING_PAYMENT" } },
  { key: "done", label: "배송 준비 전", count: "queueDonePending", warn: false, set: { ...NO, period: "all", queue: "done", prepared: "false" } },
  { key: "tracking", label: "송장 미입력", count: "trackingMissing", warn: true, set: { ...NO, period: "all", trackingMissing: "true" } },
  { key: "refund", label: "취소 · 환불 요청", count: "refundRequested", warn: true, set: { ...NO, period: "all", refundRequested: "true" } },
  { key: "waiting", label: "개봉 대기", count: "queueWaiting", warn: false, set: { ...NO, period: "all", queue: "waiting" } },
  { key: "all", label: "전체", count: "total", warn: false, set: { ...NO, period: "all" } },
] as const;
type Filters = { statuses: OrderStatus[]; period: Period | null; q: string; shipped: Shipped | null; queue: string; prepared: boolean; refundRequested: boolean; trackingMissing: boolean };
type Page = { orders: OrderRow[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: OrderRow[]; next: string | null };

function query(f: Filters, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  for (const s of f.statuses) p.append("status", s);
  if (f.period) p.set("from", kstDaysAgo(PERIODS.find((x) => x.key === f.period)!.days));
  if (f.q) p.set("q", f.q);
  if (f.shipped) p.set("shipped", f.shipped);
  if (f.queue) p.set("queue", f.queue);
  if (f.prepared) p.set("prepared", "false");
  if (f.refundRequested) p.set("refundRequested", "true");
  if (f.trackingMissing) p.set("trackingMissing", "true");
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

// 주문 상태 열: 결제 · 개봉 · 발송 · 환불 요청을 한 칸으로 합친다(정본 SA-021-OPS)
function stageOf(o: OrderRow): { label: string; cls: string } {
  if (o.refundRequest && o.refundRequest.pendingCount > 0) return { label: "취소 요청", cls: "b-cancel" };
  if (o.status === "PENDING_PAYMENT") return { label: "입금 전", cls: "b-wait" };
  if (o.status === "CANCELLED") return { label: "취소", cls: "b-cancel" };
  if (o.status === "REFUNDED") return { label: "환불됨", cls: "b-cancel" };
  if (o.shipment?.state === "delivered") return { label: "배송 완료", cls: "b-gray nodot" };
  if (o.shipped) return { label: "배송 중", cls: "b-info" };
  if (o.shippingPreparedAt) return { label: "배송 준비", cls: "b-gray nodot" };
  if (o.queueState === "done") return { label: "개봉 완료", cls: "b-done" };
  if (o.queueState === "waiting" || o.queueState === "opening") return { label: "개봉 대기", cls: "b-info" };
  return { label: "배송 준비", cls: "b-gray nodot" };
}
// 일괄로 바꿀 수 있는 주문: 개봉 완료이고 아직 배송 준비로 바꾸지 않은 것(서버도 같은 기준)
const canPrepare = (o: OrderRow) => o.status === "PAID" && !o.shipped && !o.shippingPreparedAt && o.queueState === "done";
function elapsedText(o: OrderRow): { text: string; urgent: boolean } {
  const now = Date.now();
  if (o.status === "PENDING_PAYMENT" && o.paymentDueAt) {
    const left = new Date(o.paymentDueAt).getTime() - now;
    if (left <= 0) return { text: "입금 기한 지남", urgent: true };
    const min = Math.ceil(left / 60_000);
    // 한 시간 안이면 분 단위로(입금 확인 화면과 같은 규칙)
    if (min < 60) return { text: `입금 기한 ${Math.max(min, 1)}분 남음`, urgent: true };
    const h = Math.floor(min / 60);
    return { text: h >= 24 ? `입금 기한 ${Math.floor(h / 24)}일 남음` : `입금 기한 ${h}시간 남음`, urgent: h < 6 };
  }
  const ago = Math.max(0, now - new Date(o.createdAt).getTime());
  const h = Math.floor(ago / 3_600_000);
  return { text: h < 1 ? "방금 접수" : h < 24 ? `${h}시간 전 접수` : `${Math.floor(h / 24)}일 전 접수`, urgent: false };
}
// 관리 열 주 버튼은 주문 상태에 따라 다르다(정본: 입금 전 「입금 확인」 · 배송 준비 「송장 입력」 · 취소 요청 「환불 처리」)
function mainAction(o: OrderRow): { label: string; href: string; neg?: boolean } | null {
  if (o.refundRequest && o.refundRequest.pendingCount > 0) return { label: "환불 처리", href: "/seller/orders/refund-requests", neg: true };
  if (o.status === "PENDING_PAYMENT" && o.paymentMethod === "BANK_TRANSFER") return { label: "입금 확인", href: "/seller/orders/deposits" };
  if (canPrepare(o)) return null; // 「배송 준비」 버튼은 행에서 따로 그린다
  if (o.status === "PAID" && !o.shipped && (o.queueState === "waiting" || o.queueState === "opening") && !o.shippingPreparedAt) return { label: "방송 대시보드", href: "/seller/broadcast" };
  if (o.status === "PAID" && !o.shipped) return { label: "송장 입력", href: "/seller/shipping" };
  if (o.refundable) return { label: "환불 처리", href: `/seller/orders/${o.id}?refund=1`, neg: true };
  return null;
}

export default function OrderListPage() {
  // 검색어·기간·결제 상태는 주소(쿼리)가 기준이다. 상세에 갔다 Back으로 돌아와도 그대로 복원된다(IA Back 규칙 3항)
  const [u, setU] = useUrlState({ q: "", period: "30d", status: "", shipped: "", queue: "", prepared: "", refundRequested: "", trackingMissing: "" });
  const q = u.q;
  // 기본 최근 30일(≈1개월). 홈 「처리할 일」 같은 업무 큐 링크는 ?period=all(기간 전체)로 들어온다. 칩을 눌러 해제해도 전체 기간(정본 lib/client/filterDefaults.ts)
  const period = u.period === "all" ? null : (PERIODS.find((p) => p.key === u.period)?.key ?? "30d");
  const statuses = u.status.split(",").filter((x): x is OrderStatus => STATUSES.includes(x as OrderStatus));
  const statusKey = statuses.join(",");
  // 발송 여부는 파트너스 홈 「배송 준비」 링크(?status=PAID&shipped=false)로 들어올 때 쓴다. 화면에서는 칩으로 보이고 누르면 해제된다
  const shipped: Shipped | null = u.shipped === "true" || u.shipped === "false" ? u.shipped : null;
  const setPeriod = (v: Period | null) => setU({ period: v ?? "all" });
  const setStatuses = (v: OrderStatus[]) => setU({ status: v.join(",") });
  const [search, setSearch] = useState(q);
  const setUrl = useRef(setU);
  setUrl.current = setU;
  // 이 화면이 직접 주소에 넣은 검색어(sent)는 입력 칸에 되돌려 쓰지 않는다. 입력이 이어지는 중에 늦게 반영돼도 글자가 지워지지 않게
  const sent = useRef(q);
  useEffect(() => {
    const t = setTimeout(() => {
      sent.current = search.trim();
      setUrl.current({ q: sent.current });
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [search]);
  // 주소가 밖에서 바뀌면(Back·필터 초기화) 입력 칸도 맞춘다
  useEffect(() => {
    if (q === sent.current) return;
    sent.current = q;
    setSearch(q);
  }, [q]);
  const [menuOpen, setMenuOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(u.q !== "");
  const [draft, setDraft] = useState<OrderStatus[]>([]);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const paging = useRef(false);
  const [toastState, setToastState] = useState<{ text: string; neg: boolean } | null>(null);
  const setToast = (text: string, neg = false) => setToastState({ text, neg });
  const [counts, setCounts] = useState<Counts | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  // 주문 메모 창(행 「···」 → 「메모 남기기」). 서버 #1233: 1,000자, 빈 글이면 삭제
  const [memo, setMemo] = useState<{ order: OrderRow; text: string; saved: string; loaded: boolean; loading: boolean; saving: boolean; error: string } | null>(null);
  const loadCounts = useCallback(async () => {
    const r = await api<{ counts: Counts }>("/api/seller/orders/counts");
    if (r.ok) setCounts(r.data.counts);
  }, []);
  useEffect(() => void loadCounts(), [loadCounts]);

  // 필터를 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 요청의 응답만 반영한다
  const reqId = useRef(0);
  const queue = u.queue === "waiting" || u.queue === "opening" || u.queue === "done" ? u.queue : "";
  const prepared = u.prepared === "false";
  const refundRequested = u.refundRequested === "true";
  const trackingMissing = u.trackingMissing === "true";
  const filters: Filters = { statuses, period, q, shipped, queue, prepared, refundRequested, trackingMissing };
  // 일괄 처리 응답이 늦게 와도 그 사이 바뀐 조건으로 다시 불러오도록 최신 조건을 따로 들고 있는다
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    paging.current = false;
    setMore(false);
    setPage(1);
    setCursors([undefined]);
    setState({ kind: "loading" });
    const r = await api<Page>(`/api/seller/orders?${query(f)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.orders, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => void load({ statuses: statusKey ? (statusKey.split(",") as OrderStatus[]) : [], period, q, shipped, queue, prepared, refundRequested, trackingMissing }), [statusKey, period, q, shipped, queue, prepared, refundRequested, trackingMissing, load]);
  useScrollRestore("seller-orders", state.kind === "ok");

  const changePage = async (target: number) => {
    if (state.kind !== "ok" || paging.current || target === page || target < 1 || target > cursors.length + 1) return;
    const cursor = target <= cursors.length ? cursors[target - 1] : state.next;
    if (target > 1 && !cursor) return;
    paging.current = true;
    setMore(true);
    const id = ++reqId.current;
    const r = await api<Page>(`/api/seller/orders?${query(filters, cursor ?? undefined)}`);
    if (id !== reqId.current) return;
    paging.current = false;
    setMore(false);
    if (r.ok) {
      setState({ kind: "ok", items: r.data.orders, next: r.data.nextCursor });
      setPage(target);
      if (target > cursors.length) setCursors([...cursors, cursor ?? undefined]);
    }
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오", true);
  };

  // 선택한 개봉 완료 주문을 「배송 준비」로 바꾼다(POST /api/seller/orders/bulk). 서버가 건너뛴 주문은 사유를 알린다
  const prepare = async (ids: string[]) => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    const r = await api<{ results: { orderId: string; ok: boolean; reason?: string }[]; prepared: number }>("/api/seller/orders/bulk", { method: "POST", body: { action: "prepare_shipping", orderIds: ids } });
    setBusy(false);
    if (!r.ok) return setToast("배송 준비로 바꾸지 못했습니다. 다시 시도해 주십시오", true);
    const failed = r.data.results.filter((x) => !x.ok).length;
    setToast(failed === 0 ? `${r.data.prepared}건을 배송 준비로 바꿨습니다` : `${r.data.prepared}건을 바꿨고 ${failed}건은 바꾸지 못했습니다`, failed > 0);
    setPicked([]);
    void load(filtersRef.current);
    void loadCounts();
  };

  const openMemo = async (order: OrderRow) => {
    setRowMenu(null);
    setMemo({ order, text: "", saved: "", loaded: false, loading: true, saving: false, error: "" });
    const r = await api<{ memo: { body: string } | null }>(`/api/seller/orders/${order.id}/memo`);
    setMemo((m) => (m && m.order.id === order.id ? (r.ok ? { ...m, text: r.data.memo?.body ?? "", saved: r.data.memo?.body ?? "", loaded: true, loading: false } : { ...m, loading: false, error: "메모를 불러오지 못했습니다. 다시 시도해 주십시오" }) : m));
  };
  const saveMemo = async () => {
    if (!memo || !memo.loaded || memo.saving) return;
    setMemo({ ...memo, saving: true, error: "" });
    const r = await api<{ memo: unknown }>(`/api/seller/orders/${memo.order.id}/memo`, { method: "PUT", body: { body: memo.text } });
    if (!r.ok) {
      const msg = r.error === "memo_member_withdrawn" ? "탈퇴한 회원의 주문에는 메모를 새로 남길 수 없습니다" : "메모를 저장하지 못했습니다. 다시 시도해 주십시오";
      return setMemo((m) => (m ? { ...m, saving: false, error: msg } : m));
    }
    setMemo(null);
    setToast(memo.text.trim() ? "메모를 저장했습니다" : "메모를 지웠습니다");
  };

  const openMenu = () => {
    setDraft(statuses);
    setMenuOpen((v) => !v);
  };
  const applyMenu = () => {
    setStatuses(draft.length === STATUSES.length ? [] : draft);
    setMenuOpen(false);
  };
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const filtered = statuses.length > 0 || period !== "30d" || q !== "" || shipped !== null || queue !== "" || prepared || refundRequested || trackingMissing;
  const reset = () => {
    setSearch("");
    sent.current = "";
    setU({ q: "", period: "30d", status: "", shipped: "", queue: "", prepared: "", refundRequested: "", trackingMissing: "" });
  };
  const statusText = statuses.length === 0 ? "전체" : statuses.length === 1 ? STATUS_BADGE[statuses[0]].label : `${STATUS_BADGE[statuses[0]].label} 외 ${statuses.length - 1}개`;
  const chipOn = (k: (typeof CHIPS)[number]["key"]) => {
    const c = CHIPS.find((x) => x.key === k)!.set as Record<string, string>;
    if (k === "all") return statuses.length === 0 && !shipped && !queue && !prepared && !refundRequested && !trackingMissing && period !== "today";
    if (k === "today") return period === "today" && !statuses.length && !shipped && !queue && !prepared && !refundRequested && !trackingMissing;
    return u.status === c.status && u.shipped === c.shipped && u.queue === c.queue && u.prepared === c.prepared && u.refundRequested === c.refundRequested && u.trackingMissing === c.trackingMissing;
  };
  const items = state.kind === "ok" ? state.items : [];
  const countText = state.kind === "ok" ? `${page}페이지 · ${items.length}건${state.next ? " · 다음 페이지 있음" : ""}` : "";
  const periodLabel = PERIODS.find((p) => p.key === period)?.label;

  return (
    <>
      <Topbar crumb="판매 › 주문" />
      <main className="main">
        <PageHead
          title="전체 주문"
          description="결제·배송 상태로 주문을 찾고 입금 확인·송장 입력·환불 처리를 진행합니다."
          back={false}
          actions={
            <>
              <Link className="btn btn-out" href="/seller/orders/deposits">
                입금 확인
              </Link>
              <Link className="btn btn-out" href="/seller/shipping">
                배송
              </Link>
            </>
          }
        />

        <section className="au-list-section" style={{ overflow: "visible" }}>
          <div className="toolbar ord-toolbar ord-chips" role="group" aria-label="주문 상태">
            {CHIPS.map((c) => (
              <button key={c.key} type="button" className={`chip${chipOn(c.key) ? " on" : ""}`} aria-pressed={chipOn(c.key)} onClick={() => setU(c.set)}>
                {c.label}
                {counts && (
                  <b className={`num ord-chip-n${c.warn && counts[c.count] > 0 ? " c-neg" : ""}`}> {counts[c.count].toLocaleString("ko-KR")}</b>
                )}
              </button>
            ))}
            <span className="ord-count-note c-alt t-l2" aria-live="polite">
              {filtered && state.kind === "ok" ? `결과 ${countText}` : countText}
            </span>
            <button type="button" className="btn btn-dense btn-out ord-detail-btn" aria-expanded={detailOpen} onClick={() => setDetailOpen((v) => !v)}>
              {detailOpen ? "상세 검색 접기" : "상세 검색 펼치기"}
            </button>
          </div>
          {detailOpen && (
          <div className="toolbar ord-toolbar">
            <div className="search ord-search">
              <input
                className="inp inp-sm"
                type="search"
                placeholder="닉네임 · 주문번호"
                aria-label="주문 검색"
                value={search}
                maxLength={MAX_SEARCH_LENGTH}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {PERIODS.map((p) => (
              <button key={p.key} type="button" className={`chip${period === p.key ? " on" : ""}`} aria-pressed={period === p.key} onClick={() => setPeriod(period === p.key ? null : p.key)}>
                {p.label}
                {period === p.key && <span className="x">×</span>}
              </button>
            ))}
            {shipped && (
              <button type="button" className="chip on" aria-pressed="true" onClick={() => setU({ shipped: "" })}>
                {shipped === "false" ? "발송 전" : "발송함"}
                <span className="x">×</span>
              </button>
            )}
            <div className="ord-menu-wrap">
              <button type="button" className={`chip${statuses.length ? " on" : ""}`} aria-haspopup="true" aria-expanded={menuOpen} onClick={openMenu}>
                상태: {statusText} {menuOpen ? "▴" : "▾"}
              </button>
              {menuOpen && (
                <div className="menu ord-menu" role="group" aria-label="결제 상태">
                  <span className="menu-h">결제 상태</span>
                  <label className="ord-menu-i">
                    <input className="cbx" type="checkbox" checked={draft.length === 0 || draft.length === STATUSES.length} onChange={() => setDraft([])} />
                    <span>전체</span>
                  </label>
                  {STATUSES.map((s) => (
                    <label key={s} className="ord-menu-i">
                      <input
                        className="cbx"
                        type="checkbox"
                        checked={draft.includes(s)}
                        onChange={(e) => setDraft(e.target.checked ? [...draft, s] : draft.filter((x) => x !== s))}
                      />
                      <span className={`bdg ${STATUS_BADGE[s].cls}`}>{STATUS_BADGE[s].label}</span>
                    </label>
                  ))}
                  <hr className="divider" style={{ margin: "4px 0" }} />
                  <div className="row ord-menu-f">
                    <button className="btn btn-dense btn-out btn-w-sm" type="button" onClick={() => setDraft([])}>
                      초기화
                    </button>
                    <button className="btn btn-dense btn-w-sm" type="button" onClick={applyMenu}>
                      이 상태로 보기
                    </button>
                  </div>
                </div>
              )}
            </div>
            {filtered && (
              <button className="btn btn-dense btn-text" type="button" onClick={reset}>
                필터 초기화
              </button>
            )}
          </div>
          )}

          {state.kind === "loading" && <div className="card"><LoadingRows rows={5} /></div>}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="주문·배송" /> : <div className="card"><ErrorState title="주문을 불러오지 못했습니다" onRetry={() => void load(filters)} /></div>)}
          {state.kind === "ok" && items.length === 0 && (
            <div className="card"><div className="st" style={{ boxShadow: "none" }}>
              {!filtered ? (
                <>
                  <div className="st-ic">0</div>
                  <span className="t">아직 주문이 없습니다</span>
                  <span className="s">첫 방송을 시작하고 쇼핑몰 링크를 공유해 보십시오.</span>
                </>
              ) : q && period ? (
                <>
                  <div className="st-ic">?</div>
                  <span className="t">「{q}」 검색 결과가 없습니다</span>
                  <span className="s">기간 필터 「{periodLabel}」을 해제하면 전체 기간에서 찾습니다.</span>
                  <button className="btn btn-dense btn-out btn-w-xl" type="button" onClick={() => setPeriod(null)}>
                    전체 기간에서 검색
                  </button>
                </>
              ) : (
                <>
                  <div className="st-ic">?</div>
                  <span className="t">조건에 맞는 주문이 없습니다</span>
                  <button className="btn btn-dense btn-text" type="button" onClick={reset}>
                    필터 초기화
                  </button>
                </>
              )}
            </div></div>
          )}
          {picked.length > 0 && (
            <div className="ord-bulk" role="region" aria-label="선택한 주문">
              <b>{picked.length}개 선택</b>
              <span className="c-alt t-l2">· 개봉 완료 {picked.length}건 · 다른 상태는 체크할 수 없습니다</span>
              <span className="ord-bulk-act">
                <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void prepare(picked)}>
                  배송 준비로 변경
                </button>
                <Link className="btn btn-sm btn-out" href="/seller/shipping">
                  송장 일괄 입력
                </Link>
                <button className="btn btn-sm btn-out" type="button" onClick={() => setPicked([])}>
                  선택 해제
                </button>
              </span>
            </div>
          )}
          {state.kind === "ok" && items.length > 0 && (
            <ListTable className="ord-scroll">
              <table className="tbl tbl-card ord-tbl2" data-testid="orders-table">
                <thead>
                  <tr>
                    <th data-card="check">
                      <input
                        className="chkbox"
                        type="checkbox"
                        aria-label="선택할 수 있는 주문 모두 선택"
                        checked={items.filter(canPrepare).length > 0 && items.filter(canPrepare).every((o) => picked.includes(o.id))}
                        disabled={items.filter(canPrepare).length === 0}
                        onChange={(e) => setPicked(e.target.checked ? items.filter(canPrepare).map((o) => o.id) : [])}
                      />
                    </th>
                    <th>접수 · 경과</th>
                    <th>구매자</th>
                    <th>상품</th>
                    <th>금액</th>
                    <th>결제</th>
                    <th>주문 상태</th>
                    <th>관리</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((o) => {
                    const stage = stageOf(o);
                    const act = mainAction(o);
                    return (
                      <tr key={o.id} className={o.status === "PENDING_PAYMENT" ? "faded" : ""} data-testid="order-row">
                        <td data-card="check">
                          <input
                            className="chkbox"
                            type="checkbox"
                            aria-label={`${o.orderNoLabel} 선택`}
                            disabled={!canPrepare(o)}
                            checked={picked.includes(o.id)}
                            onChange={(e) => setPicked(e.target.checked ? [...picked, o.id] : picked.filter((x) => x !== o.id))}
                          />
                        </td>
                        <td className="date" data-card="title">
                          <Link href={`/seller/orders/${o.id}`} className="fw6 num ord-link">
                            {formatDateTimeParts(o.createdAt)?.date} {formatDateTimeParts(o.createdAt)?.time}
                          </Link>
                          <div className="ord-ono num">{o.orderNoLabel}</div>
                          <div className={`t-c1 ${elapsedText(o).urgent ? "c-neg" : "c-alt"}`}>{elapsedText(o).text}</div>
                        </td>
                        <td data-card="field">
                          <div className="fw6">{o.buyer.broadcastNickname}</div>
                          {o.buyer.grade && <div className="t-c1 c-alt">{o.buyer.grade.displayName}</div>}
                        </td>
                        <td className="ell ord-product col-text" data-card="wide">{itemSummaryText(o.itemSummary)}</td>
                        <td className="num" data-card="field">
                          {won(o.totalAmount)}
                          {o.refundedAmount > 0 && <div className="ord-rf c-neg">환불 {won(o.refundedAmount)}</div>}
                        </td>
                        <td data-card="field">
                          {o.paymentMethod ? <div>{o.paymentMethod === "CARD" ? "카드" : "무통장"}</div> : <span className="c-alt">—</span>}
                          {o.refundedAmount > 0 && o.status === "PAID" && <span className="bdg b-cancel">부분 환불</span>}
                        </td>
                        <td data-card="status">
                          <span className={`bdg ${stage.cls}`}>{stage.label}</span>
                        </td>
                        <td data-card="actions">
                          <span className="row" style={{ gap: 4, justifyContent: "flex-end", flexWrap: "nowrap" }}>
                            {canPrepare(o) && (
                              <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void prepare([o.id])}>
                                배송 준비
                              </button>
                            )}
                            {act && (
                              <Link className={`btn btn-sm${act.neg ? " btn-out" : ""}`} style={act.neg ? { color: "var(--neg-text)" } : undefined} href={act.href}>
                                {act.label}
                              </Link>
                            )}
                            <Link className="btn btn-sm btn-out" href={`/seller/orders/${o.id}`}>
                              상세
                            </Link>
                            {!o.shipped && (o.status === "PENDING_PAYMENT" || o.status === "PAID") && (
                              <span className="ord-menu-wrap">
                                <button className="btn btn-sm btn-out" type="button" aria-label={`${o.orderNoLabel} 더보기`} aria-haspopup="true" aria-expanded={rowMenu === o.id} onClick={() => setRowMenu(rowMenu === o.id ? null : o.id)}>
                                  ···
                                </button>
                                {rowMenu === o.id && (
                                  <div className="menu ord-menu ord-row-menu" role="menu" onMouseLeave={() => setRowMenu(null)}>
                                    <button role="menuitem" type="button" onClick={() => void openMemo(o)}>
                                      메모 남기기
                                    </button>
                                    <Link role="menuitem" href="/seller/orders/receipts">영수증 발급</Link>
                                    {o.status === "PAID" && (
                                      <Link role="menuitem" className="c-neg" href={`/seller/orders/${o.id}?refund=1`}>
                                        주문 취소
                                      </Link>
                                    )}
                                  </div>
                                )}
                              </span>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </ListTable>
          )}
          {state.kind === "ok" && (state.next || page > 1) && (
            <div className="row ord-more" aria-busy={more}>
              <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={(n) => void changePage(n)} onNext={() => void changePage(page + 1)} />
            </div>
          )}
        </section>
      </main>
      {memo && (
        <Modal labelId="ord-memo-title" busy={memo.saving} dirty={memo.loaded && memo.text !== memo.saved} onClose={() => setMemo(null)}>
          {(requestClose) => (
            <>
              <div className="modal-h">
                <h2 className="modal-t" id="ord-memo-title">
                  메모 남기기
                </h2>
              </div>
              <div className="col" style={{ gap: 8 }}>
                <p className="help">{memo.order.orderNoLabel} · 구매자에게는 보이지 않는 내부 메모입니다.</p>
                <textarea className="inp" rows={5} aria-label="메모" placeholder="메모 입력" disabled={!memo.loaded || memo.saving} value={memo.text} onChange={(e) => textLength(e.target.value) <= 1000 && setMemo({ ...memo, text: e.target.value })} />
                <span className="help">{textLength(memo.text)}/1,000자</span>
                {memo.error && (
                  <p className="c-neg" role="alert">
                    {memo.error}
                  </p>
                )}
              </div>
              <div className="modal-f">
                <button className="btn btn-out" type="button" onClick={requestClose}>
                  취소
                </button>
                <button className="btn btn-pri" type="button" disabled={!memo.loaded || memo.saving || memo.text === memo.saved} onClick={() => void saveMemo()}>
                  저장
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {toastState && <Toast text={toastState.text} neg={toastState.neg} onDone={() => setToastState(null)} />}
    </>
  );
}
