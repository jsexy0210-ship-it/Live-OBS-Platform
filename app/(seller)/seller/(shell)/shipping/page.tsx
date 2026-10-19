"use client";

import { formatDateTime } from "../../../../../lib/client/format";
import Link from "next/link";
import { CursorPagination } from "../../../../../components/Pagination";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListTable, PageHead } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api } from "../../../../../components/seller/api";
import { MAX_SEARCH_LENGTH } from "../../../../../components/seller/format";
import { itemSummaryText, phoneText } from "../../../../../components/seller/orders";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import { COURIERS, isCourier } from "../../../../../lib/server/orders/shipping";
import "../../../../../styles/seller-shipping.css";

// SA-025 배송 처리(GET·POST /api/seller/shipments, POST …/deliver, 주문·배송 권한).
// 발송 대기: 택배사를 고르고 송장번호를 적어 여러 건을 한 번에 저장 → 배송 중으로 옮겨 간다.
// 배송 중: 골라서 배송 완료 처리. 배송 완료: 조회만. 묶음 처리는 주문별로 성공·실패가 따로 온다(부분 성공).
// 받는 분 정보는 개인정보 열람 권한이 있을 때만 응답에 온다.
type Tab = "ready" | "in_transit" | "delivered";
const TABS: { key: Tab; label: string }[] = [
  { key: "ready", label: "발송 대기" },
  { key: "in_transit", label: "배송 중" },
  { key: "delivered", label: "배송 완료" },
];
const PAGE = 10;
const SEARCH_DELAY_MS = 300;

type Row = {
  orderId: string;
  orderNo: number;
  createdAt: string;
  buyer: { id: string; broadcastNickname: string | null };
  itemSummary: { firstProductName: string | null; otherCount: number };
  shipment: { courier: string; trackingNumber: string; status: string; shippedAt: string; deliveredAt: string | null } | null;
  shippingAddress: { recipientName?: string; phone?: string; zipCode?: string; address1?: string; address2?: string | null; memo?: string | null; isRemote: boolean } | null;
};
type Page = { shipments: Row[]; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: Row[]; next: string | null };
const courierName = (c: string) => (isCourier(c) ? COURIERS[c] : c);

function query(tab: Tab, q: string, cursor?: string) {
  const p = new URLSearchParams({ tab, limit: String(PAGE) });
  if (q) p.set("q", q);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export default function ShippingPage() {
  const { can, me } = useSeller();
  const canEdit = can("ORDER_SHIPPING") && !me.readOnly;
  // 탭·검색어는 주소(쿼리 ?tab·?q)가 기준이다. 주문 상세에 갔다 Back으로 돌아와도 그대로 복원된다(UX 감사 9.3). 틀린 탭 값은 발송 대기로 본다
  const [u, setU] = useUrlState({ tab: "ready", q: "" });
  const tab: Tab = TABS.some((t) => t.key === u.tab) ? (u.tab as Tab) : "ready";
  const q = u.q;
  const setTab = (t: Tab) => setU({ tab: t });
  const [search, setSearch] = useState(q);
  const setUrl = useRef(setU);
  setUrl.current = setU;
  useEffect(() => {
    const t = setTimeout(() => setUrl.current({ q: search.trim() }), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [search]);
  // 주소가 바뀌면(Back·탭 이동) 입력 칸도 맞춘다. 입력 중인 글자는 건드리지 않는다
  useEffect(() => {
    setSearch((cur) => (cur.trim() === q ? cur : q));
  }, [q]);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [page, setPage] = useState(1);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const paging = useRef(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  // 탭·검색을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (t: Tab, s: string, quiet = false) => {
    const id = ++reqId.current;
    paging.current = false;
    if (!quiet) { setPage(1); setCursors([undefined]); }
    if (!quiet) setState({ kind: "loading" });
    const r = await api<Page>(`/api/seller/shipments?${query(t, s)}`);
    if (id !== reqId.current) return false;
    if (r.ok) { setState({ kind: "ok", items: r.data.shipments, next: r.data.nextCursor }); setPage(1); setCursors([undefined]); }
    else if (!quiet) setState({ kind: "error", status: r.status });
    return r.ok;
  }, []);
  useEffect(() => {
    setPicked(new Set());
    void load(tab, q);
  }, [tab, q, load]);

  useScrollRestore("seller-shipping", state.kind === "ok");

  const goPage = async (target: number, cursor = cursors[target - 1]) => {
    if (state.kind !== "ok" || paging.current || target < 1 || target > cursors.length + 1) return;
    paging.current = true;
    const id = reqId.current;
    const r = await api<Page>(`/api/seller/shipments?${query(tab, q, cursor)}`);
    if (id !== reqId.current) return;
    paging.current = false;
    if (r.ok) {
      setState({ kind: "ok", items: r.data.shipments, next: r.data.nextCursor });
      setCursors((prev) => [...prev.slice(0, target - 1), cursor]); setPage(target);
      setPicked(new Set());
    } else setToast({ text: "목록을 불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
  };

  const items = state.kind === "ok" ? state.items : [];
  const workIds = items.filter((item) => picked.has(item.orderId)).map((item) => item.orderId);
  const workHref = `/seller/shipping/process?${new URLSearchParams({ ids: workIds.join(","), action: tab === "in_transit" ? "deliver" : "ship" })}`;

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allPicked = items.length > 0 && items.every((r) => picked.has(r.orderId));
  const selectable = canEdit && tab !== "delivered";

  return (
    <>
      <Topbar crumb="판매 › 배송" />
      <main className="main">
        <PageHead title="배송" />

        <section className="au-list-section">
          <nav className="tabs" aria-label="배송 상태" style={{ padding: "0 16px" }}>
            {TABS.map((t) => (
              <button key={t.key} type="button" className={`tab${tab === t.key ? " on" : ""}`} aria-pressed={tab === t.key} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </nav>
          <div className="toolbar" style={{ padding: 16 }}>
            <div className="search" style={{ flex: "1 1 220px" }}>
              <input
                className="inp inp-sm"
                type="search"
                placeholder="주문번호 · 닉네임 · 송장번호"
                aria-label="배송 검색"
                value={search}
                maxLength={MAX_SEARCH_LENGTH}

                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {selectable && (workIds.length > 0 ? <Link className="btn btn-sm" href={workHref}>선택 배송 작업 상세 ({workIds.length})</Link> : <button className="btn btn-sm" type="button" disabled>선택 배송 작업 상세</button>)}
          </div>

          {state.kind === "loading" && <div className="card"><LoadingRows rows={5} /></div>}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="주문·배송" /> : <div className="card"><ErrorState title="배송 목록을 불러오지 못했습니다" onRetry={() => void load(tab, q)} /></div>)}
          {state.kind === "ok" &&
            (items.length === 0 ? (
              <div className="st">
                <span className="t">{q ? "조건에 맞는 주문이 없습니다" : tab === "ready" ? "발송할 주문이 없습니다" : tab === "in_transit" ? "배송 중인 주문이 없습니다" : "배송 완료된 주문이 없습니다"}</span>
              </div>
            ) : (
              <>
                <ListTable>
                  <table className={`tbl ship-tbl${selectable ? " ship-sel" : ""}`}>
                    <thead>
                      <tr>
                        {selectable && (
                          <th style={{ width: 40 }}>
                            <input className="cbx" type="checkbox" aria-label="모두 선택" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(items.map((r) => r.orderId)))} />
                          </th>
                        )}
                        <th>주문</th>
                        <th>받는 분</th>
                        <th>{tab === "ready" ? "송장번호" : "택배사 · 송장번호"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((r) => (
                        <tr key={r.orderId} data-testid="shipment-row">
                          {selectable && (
                            <td>
                              <input className="cbx" type="checkbox" aria-label={`주문 ${r.orderNo} 선택`} checked={picked.has(r.orderId)} onChange={() => toggle(r.orderId)} />
                            </td>
                          )}
                          <td className="col-text">
                            <div className="col" style={{ gap: 2 }}>
                              <Link className="fw6" href={`/seller/orders/${r.orderId}`}>
                                {r.buyer.broadcastNickname ?? "닉네임 없음"}
                              </Link>
                              <span className="t-c1 ship-item" title={itemSummaryText(r.itemSummary)}>
                                {itemSummaryText(r.itemSummary)}
                              </span>
                              <span className="t-c1 c-alt num">
                                주문번호 {r.orderNo} · {formatDateTime(r.createdAt)}
                              </span>
                            </div>
                          </td>
                          <td className="ship-rcpt col-text">
                            <Recipient a={r.shippingAddress} />
                          </td>
                          <td>
                            {r.shipment ? <div className="col" style={{ gap: 2 }}><span>{courierName(r.shipment.courier)}</span><span className="t-c1 c-alt num">{r.shipment.trackingNumber}</span></div> : "—"}
                            <Link className="btn btn-sm btn-out" href={`/seller/shipping/${r.orderId}`}>배송 작업 상세</Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ListTable>
                <div className="row" style={{ justifyContent: "space-between", padding: "12px 16px" }}>
                  <span className="t-c1 c-alt">{`${items.length}건 표시`}</span>

                </div>
              </>
            ))}
          {state.kind === "ok" && (page > 1 || state.next) && <CursorPagination page={page} visited={cursors.length} hasNext={!!state.next} onChange={(target) => void goPage(target)} onNext={() => { if (state.next) void goPage(page + 1, state.next); }} />}
        </section>
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}

function Recipient({ a }: { a: Row["shippingAddress"] }) {
  if (!a) return <span className="c-alt">-</span>;
  const remote = a.isRemote ? <span className="bdg b-warn nodot">도서산간</span> : null;
  if (a.recipientName === undefined) {
    return <div className="col" style={{ gap: 2 }}>{remote ?? <span className="t-c1 c-alt">개인정보 열람 권한이 필요합니다</span>}</div>;
  }
  return (
    <div className="col" style={{ gap: 2 }}>
      <span>
        {a.recipientName}
        {a.phone ? <span className="c-alt"> · {phoneText(a.phone)}</span> : null}
      </span>
      <span className="t-c1 c-alt">
        {a.zipCode ? `(${a.zipCode}) ` : ""}
        {a.address1} {a.address2 ?? ""}
      </span>
      {remote}
    </div>
  );
}
