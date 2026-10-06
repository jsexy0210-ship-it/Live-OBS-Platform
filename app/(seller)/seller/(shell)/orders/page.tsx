"use client";

import { formatDateTimeParts } from "../../../../../lib/client/format";
import "../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import { PageHead } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { MAX_SEARCH_LENGTH, won } from "../../../../../components/seller/format";
import { STATUS_BADGE, itemSummaryText, kstDaysAgo, payBadge, type OrderRow, type OrderStatus } from "../../../../../components/seller/orders";

// SA-021 판매자 주문 목록. 결제 상태·기간·검색으로 걸러 보고, 20건씩 이어서 불러온다(GET /api/seller/orders).
// 환불할 수 있는 주문(refundable)만 「환불 처리」 버튼이 있고, 발송 여부(shipped)는 「배송」 열에 따로 보인다.
const PAGE = 20;
const SEARCH_DELAY_MS = 300;
const STATUSES: OrderStatus[] = ["PENDING_PAYMENT", "PAID", "CANCELLED", "REFUNDED"];
type Period = "today" | "7d" | "30d";
const PERIODS: { key: Period; label: string; days: number }[] = [
  { key: "today", label: "오늘", days: 0 },
  { key: "7d", label: "최근 7일", days: 6 },
  { key: "30d", label: "최근 30일", days: 29 },
];
type Shipped = "true" | "false";
// 상태 칩(정본 SA-021-OPS): 지금 서버 필터로 만들 수 있는 칩만 둔다. 「송장 미입력」 「취소 · 환불 요청」 「개봉 대기」와 칩 건수는 서버 필요(UI_STATUS)
const CHIPS = [
  { key: "today", label: "오늘", set: { period: "today", status: "", shipped: "" } },
  { key: "unpaid", label: "입금 전", set: { period: "all", status: "PENDING_PAYMENT", shipped: "" } },
  { key: "ready", label: "배송 준비 전", set: { period: "all", status: "PAID", shipped: "false" } },
  { key: "cancelled", label: "취소", set: { period: "all", status: "CANCELLED", shipped: "" } },
  { key: "refunded", label: "환불", set: { period: "all", status: "REFUNDED", shipped: "" } },
  { key: "all", label: "전체", set: { period: "all", status: "", shipped: "" } },
] as const;
type Filters = { statuses: OrderStatus[]; period: Period | null; q: string; shipped: Shipped | null };
type Page = { orders: OrderRow[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: OrderRow[]; next: string | null };

function query(f: Filters, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  for (const s of f.statuses) p.append("status", s);
  if (f.period) p.set("from", kstDaysAgo(PERIODS.find((x) => x.key === f.period)!.days));
  if (f.q) p.set("q", f.q);
  if (f.shipped) p.set("shipped", f.shipped);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

// 주문 상태 열: 결제 · 발송 · 환불 요청을 한 칸으로 합친다(정본 SA-021-OPS). 「개봉 대기 · 개봉 완료」는 주문 목록 응답에 개봉 상태가 없어 서버 필요(UI_STATUS)
function stageOf(o: OrderRow): { label: string; cls: string } {
  if (o.refundRequest && o.refundRequest.pendingCount > 0) return { label: "취소 요청", cls: "b-cancel" };
  if (o.status === "PENDING_PAYMENT") return { label: "입금 전", cls: "b-wait" };
  if (o.status === "CANCELLED") return { label: "취소", cls: "b-cancel" };
  if (o.status === "REFUNDED") return { label: "환불됨", cls: "b-cancel" };
  if (o.shipment?.state === "delivered") return { label: "배송 완료", cls: "b-gray nodot" };
  if (o.shipped) return { label: "배송 중", cls: "b-info" };
  return { label: "배송 준비", cls: "b-gray nodot" };
}
function elapsedText(o: OrderRow): { text: string; urgent: boolean } {
  const now = Date.now();
  if (o.status === "PENDING_PAYMENT" && o.paymentDueAt) {
    const left = new Date(o.paymentDueAt).getTime() - now;
    if (left <= 0) return { text: "입금 기한 지남", urgent: true };
    const h = Math.max(1, Math.round(left / 3_600_000));
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
  if (o.status === "PAID" && !o.shipped) return { label: "송장 입력", href: "/seller/shipping" };
  if (o.refundable) return { label: "환불 처리", href: `/seller/orders/${o.id}?refund=1`, neg: true };
  return null;
}

export default function OrderListPage() {
  // 검색어·기간·결제 상태는 주소(쿼리)가 기준이다. 상세에 갔다 Back으로 돌아와도 그대로 복원된다(IA Back 규칙 3항)
  const [u, setU] = useUrlState({ q: "", period: "30d", status: "", shipped: "" });
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
  const [toast, setToast] = useState<string | null>(null);

  // 필터를 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 요청의 응답만 반영한다
  const reqId = useRef(0);
  const filters: Filters = { statuses, period, q, shipped };
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await api<Page>(`/api/seller/orders?${query(f)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.orders, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => void load({ statuses: statusKey ? (statusKey.split(",") as OrderStatus[]) : [], period, q, shipped }), [statusKey, period, q, shipped, load]);
  useScrollRestore("seller-orders", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await api<Page>(`/api/seller/orders?${query(filters, state.next)}`);
    setMore(false);
    if (id !== reqId.current) return;
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.orders], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오");
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

  const filtered = statuses.length > 0 || period !== "30d" || q !== "" || shipped !== null;
  const reset = () => {
    setSearch("");
    sent.current = "";
    setU({ q: "", period: "30d", status: "", shipped: "" });
  };
  const statusText = statuses.length === 0 ? "전체" : statuses.length === 1 ? STATUS_BADGE[statuses[0]].label : `${STATUS_BADGE[statuses[0]].label} 외 ${statuses.length - 1}개`;
  const chipOn = (k: (typeof CHIPS)[number]["key"]) => {
    const c = CHIPS.find((x) => x.key === k)!.set;
    if (k === "all") return statuses.length === 0 && !shipped && period !== "today";
    return u.status === c.status && u.shipped === c.shipped && (k === "today" ? period === "today" : true);
  };
  const items = state.kind === "ok" ? state.items : [];
  const countText = state.kind === "ok" ? (state.next ? `${items.length}건 넘게` : `${items.length}건`) : "";
  const periodLabel = PERIODS.find((p) => p.key === period)?.label;

  return (
    <>
      <Topbar crumb="판매 › 주문" />
      <main className="main">
        <PageHead
          title="전체 주문"
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

        <div className="card" style={{ overflow: "visible" }}>
          <div className="toolbar ord-toolbar ord-chips" role="group" aria-label="주문 상태">
            {CHIPS.map((c) => (
              <button key={c.key} type="button" className={`chip${chipOn(c.key) ? " on" : ""}`} aria-pressed={chipOn(c.key)} onClick={() => setU(c.set)}>
                {c.label}
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

          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="주문·배송" /> : <ErrorState title="주문을 불러오지 못했습니다" onRetry={() => void load(filters)} />)}
          {state.kind === "ok" && items.length === 0 && (
            <div className="st" style={{ boxShadow: "none" }}>
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
            </div>
          )}
          {state.kind === "ok" && items.length > 0 && (
            <div className="ord-scroll">
              <table className="tbl tbl-card ord-tbl2" data-testid="orders-table">
                <thead>
                  <tr>
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
                        <td className="date" data-card="title">
                          <Link href={`/seller/orders/${o.id}`} className="fw6 num ord-link">
                            {formatDateTimeParts(o.createdAt)?.date} {formatDateTimeParts(o.createdAt)?.time}
                          </Link>
                          <div className="ord-ono num">{o.orderNoLabel}</div>
                          <div className={`t-c1 ${elapsedText(o).urgent ? "c-neg" : "c-alt"}`}>{elapsedText(o).text}</div>
                        </td>
                        <td className="fw6" data-card="field">{o.buyer.broadcastNickname}</td>
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
                            {act && (
                              <Link className={`btn btn-sm${act.neg ? " btn-out" : ""}`} style={act.neg ? { color: "var(--neg-text)" } : undefined} href={act.href}>
                                {act.label}
                              </Link>
                            )}
                            <Link className="btn btn-sm btn-out" href={`/seller/orders/${o.id}`}>
                              상세
                            </Link>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {state.kind === "ok" && state.next && (
            <div className="row ord-more">
              <button className={`btn btn-dense btn-out btn-w-xl${more ? " is-loading" : ""}`} type="button" disabled={more} onClick={() => void loadMore()}>
                주문 더 불러오기
              </button>
            </div>
          )}
        </div>
      </main>
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}
