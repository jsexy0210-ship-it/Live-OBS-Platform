"use client";

import "../../../../../styles/seller-orders.css";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { MAX_SEARCH_LENGTH, won } from "../../../../../components/seller/format";
import { STATUS_BADGE, itemSummaryText, kstDaysAgo, listDate, listTime, type OrderRow, type OrderStatus } from "../../../../../components/seller/orders";

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
type Filters = { statuses: OrderStatus[]; period: Period | null; q: string };
type Page = { orders: OrderRow[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: OrderRow[]; next: string | null };

function query(f: Filters, cursor?: string) {
  const p = new URLSearchParams({ limit: String(PAGE) });
  for (const s of f.statuses) p.append("status", s);
  if (f.period) p.set("from", kstDaysAgo(PERIODS.find((x) => x.key === f.period)!.days));
  if (f.q) p.set("q", f.q);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export default function OrderListPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [search]);
  const [statuses, setStatuses] = useState<OrderStatus[]>([]);
  const [period, setPeriod] = useState<Period | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState<OrderStatus[]>([]);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // 필터를 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 요청의 응답만 반영한다
  const reqId = useRef(0);
  const filters: Filters = { statuses, period, q };
  const load = useCallback(async (f: Filters) => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await api<Page>(`/api/seller/orders?${query(f)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.orders, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => void load({ statuses, period, q }), [statuses, period, q, load]);

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

  const filtered = statuses.length > 0 || period !== null || q !== "";
  const reset = () => {
    setStatuses([]);
    setPeriod(null);
    setSearch("");
    setQ("");
  };
  const statusText = statuses.length === 0 ? "전체" : statuses.length === 1 ? STATUS_BADGE[statuses[0]].label : `${STATUS_BADGE[statuses[0]].label} 외 ${statuses.length - 1}개`;
  const items = state.kind === "ok" ? state.items : [];
  const countText = state.kind === "ok" ? (state.next ? `${items.length}건 넘게` : `${items.length}건`) : "";
  const periodLabel = PERIODS.find((p) => p.key === period)?.label;

  return (
    <>
      <Topbar crumb="판매 › 주문" />
      <main className="main">
        <div className="ph">
          <div className="col" style={{ gap: 4 }}>
            <h1 className="t-t3">주문</h1>
            <span className="t-l2 c-alt">결제 완료된 주문만 주문대기에 올라갑니다. 미결제 주문은 「결제 대기」로 표시됩니다.</span>
          </div>
        </div>

        <div className="card" style={{ overflow: "visible" }}>
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
                  <div className="row" style={{ gap: 6, padding: 4 }}>
                    <button className="btn btn-sm btn-out" type="button" style={{ flex: 1 }} onClick={() => setDraft([])}>
                      초기화
                    </button>
                    <button className="btn btn-sm" type="button" style={{ flex: 1 }} onClick={applyMenu}>
                      적용
                    </button>
                  </div>
                </div>
              )}
            </div>
            {filtered && (
              <button className="btn btn-sm btn-text" type="button" onClick={reset}>
                필터 초기화
              </button>
            )}
            <span className="t-l2 c-alt ord-count" aria-live="polite">
              {filtered && state.kind === "ok" ? `결과 ${countText}` : countText}
            </span>
          </div>

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
                  <button className="btn btn-sm btn-out" type="button" onClick={() => setPeriod(null)}>
                    전체 기간에서 검색
                  </button>
                </>
              ) : (
                <>
                  <div className="st-ic">?</div>
                  <span className="t">조건에 맞는 주문이 없습니다</span>
                  <button className="btn btn-sm btn-text" type="button" onClick={reset}>
                    필터 초기화
                  </button>
                </>
              )}
            </div>
          )}
          {state.kind === "ok" && items.length > 0 && (
            <div className="ord-scroll">
              <table className="tbl ord-tbl">
                <thead>
                  <tr>
                    <th>접수 시각</th>
                    <th>구매자</th>
                    <th>상품</th>
                    <th className="r">금액</th>
                    <th>결제</th>
                    <th>배송</th>
                    <th style={{ width: 120 }} aria-label="작업" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((o) => (
                    <tr key={o.id} className={o.status === "PENDING_PAYMENT" ? "faded" : ""} data-testid="order-row">
                      <td>
                        <Link href={`/seller/orders/${o.id}`} className="fw6 num ord-link">
                          {listTime(o.createdAt)}
                        </Link>
                        <div className="t-c1 c-alt num">{listDate(o.createdAt)}</div>
                      </td>
                      <td className="fw6">{o.buyer.broadcastNickname}</td>
                      <td className="ell ord-product">{itemSummaryText(o.itemSummary)}</td>
                      <td className="r num">{won(o.totalAmount)}</td>
                      <td>
                        <span className={`bdg ${STATUS_BADGE[o.status].cls}`}>{STATUS_BADGE[o.status].label}</span>
                      </td>
                      <td>{o.shipped ? <span className="bdg b-info nodot">발송함</span> : <span className="c-alt">—</span>}</td>
                      <td>
                        {o.refundable && (
                          <Link className="btn btn-sm" href={`/seller/orders/${o.id}?refund=1`}>
                            환불 처리
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {state.kind === "ok" && state.next && (
            <div className="row" style={{ padding: "12px 20px", justifyContent: "center" }}>
              <button className={`btn btn-sm btn-out${more ? " is-loading" : ""}`} type="button" disabled={more} onClick={() => void loadMore()}>
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
