"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PageHead, useConfirm } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { MAX_SEARCH_LENGTH } from "../../../../../components/seller/format";
import { itemSummaryText, listDate, phoneText } from "../../../../../components/seller/orders";
import { sendInBatches } from "../../../../../components/seller/shipping/sendInBatches";
import { useScrollRestore, useUrlState } from "../../../../../lib/client/navigation";
import { COURIERS, isCourier, type Courier } from "../../../../../lib/server/orders/shipping";
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
const PAGE = 50;
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
type Result = { orderId: string; ok: boolean; error?: string; message?: string };

const courierName = (c: string) => (isCourier(c) ? COURIERS[c] : c);
const FAIL: Record<string, string> = {
  not_shippable: "지금은 발송할 수 없는 주문입니다",
  invalid_shipment: "송장번호를 확인해 주십시오",
  not_deliverable: "배송 완료로 바꿀 수 없는 주문입니다",
  not_found: "주문을 찾을 수 없습니다",
};

function query(tab: Tab, q: string, cursor?: string) {
  const p = new URLSearchParams({ tab, limit: String(PAGE) });
  if (q) p.set("q", q);
  if (cursor) p.set("cursor", cursor);
  return p.toString();
}

export default function ShippingPage() {
  const { confirm } = useConfirm();
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
  const [more, setMore] = useState(false);
  const [courier, setCourier] = useState<Courier>("CJ");
  // 줄마다 택배사를 바꿀 수 있다(없으면 위에서 고른 택배사)
  const [courierOf, setCourierOf] = useState<Record<string, Courier>>({});
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  // 탭·검색을 빨리 바꾸면 이전 응답이 늦게 올 수 있다. 마지막으로 보낸 조건의 응답만 반영한다
  const reqId = useRef(0);
  const load = useCallback(async (t: Tab, s: string, quiet = false) => {
    const id = ++reqId.current;
    if (!quiet) setState({ kind: "loading" });
    const r = await api<Page>(`/api/seller/shipments?${query(t, s)}`);
    if (id !== reqId.current) return false;
    if (r.ok) setState({ kind: "ok", items: r.data.shipments, next: r.data.nextCursor });
    else if (!quiet) setState({ kind: "error", status: r.status });
    return r.ok;
  }, []);
  useEffect(() => {
    setPicked(new Set());
    setErrors({});
    void load(tab, q);
  }, [tab, q, load]);

  useScrollRestore("seller-shipping", state.kind === "ok");

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await api<Page>(`/api/seller/shipments?${query(tab, q, state.next)}`);
    setMore(false);
    if (id !== reqId.current) return;
    if (r.ok) setState({ kind: "ok", items: [...state.items, ...r.data.shipments], next: r.data.nextCursor });
    else setToast({ text: "더 불러오지 못했습니다. 다시 눌러 주십시오", neg: true });
  };

  // 주문별 결과를 화면에 그대로 반영한다: 실패한 주문은 그 줄에 사유를 남기고, 성공 건수만 성공으로 알린다.
  const applyResults = async (results: Result[], verb: string) => {
    const okIds = results.filter((r) => r.ok).map((r) => r.orderId);
    const failed = results.filter((r) => !r.ok);
    setErrors(Object.fromEntries(failed.map((r) => [r.orderId, r.message ?? FAIL[r.error ?? ""] ?? "처리하지 못했습니다"])));
    setPicked(new Set(failed.map((r) => r.orderId)));
    setTracking((t) => Object.fromEntries(Object.entries(t).filter(([id]) => !okIds.includes(id))));
    // 처리한 행만 갱신한다: 성공한 주문은 다른 탭으로 옮겨 가므로 이 목록에서만 빼고, 불러온 쪽수·스크롤·검색 조건은 그대로 둔다
    setState((s) => (s.kind === "ok" ? { ...s, items: s.items.filter((r) => !okIds.includes(r.orderId)) } : s));
    const parts = [okIds.length > 0 ? `${okIds.length}건 ${verb}` : null, failed.length > 0 ? `${failed.length}건은 처리하지 못했습니다. 빨간 글씨를 확인해 주십시오` : null].filter(Boolean).join(" · ");
    setToast({ text: parts, neg: failed.length > 0 && okIds.length === 0 });
  };

  const items = state.kind === "ok" ? state.items : [];
  const readyTargets = items.filter((r) => picked.has(r.orderId) && (tracking[r.orderId] ?? "").trim() !== "");
  const missing = items.filter((r) => picked.has(r.orderId) && (tracking[r.orderId] ?? "").trim() === "").length;

  // 묶음 나누기·부분 실패 처리는 sendInBatches(단위 시험 있음).
  // 처리 중에는 탭·검색을 잠가, 끝난 뒤 다시 읽기가 지금 보고 있는 조건과 같게 한다.
  const send = async <T,>(path: string, list: T[], body: (chunk: T[]) => unknown, idOf: (x: T) => string, verb: string, failText: string) => {
    setBusy(true);
    // 서버 한도(SHIPMENT_BATCH_MAX)만큼씩 나눠 보낸다
    const { results, lastFail } = await sendInBatches(list, idOf, async (chunk) => {
      const r = await api<{ results: Result[] }>(path, { method: "POST", body: body(chunk) });
      return r.ok ? { results: r.data.results } : { failMessage: failMessage(r, "admin", failText) };
    });
    if (results.every((r) => !r.ok) && lastFail) {
      setBusy(false);
      return setToast({ text: lastFail, neg: true });
    }
    await applyResults(results, verb);
    setBusy(false);
  };

  const ship = async () => {
    if (readyTargets.length === 0) return;
    if (!(await confirm({ title: `송장 ${readyTargets.length}건을 저장하시겠습니까?`, body: "택배사·송장번호를 저장하고 해당 주문을 「배송 중」으로 바꿉니다. 구매자에게 알림이 갑니다.", confirmLabel: "송장 저장" }))) return;
    await send(
      "/api/seller/shipments",
      readyTargets,
      (chunk) => ({ items: chunk.map((x) => ({ orderId: x.orderId, courier: courierOf[x.orderId] ?? courier, trackingNumber: tracking[x.orderId].trim() })) }),
      (x) => x.orderId,
      "송장 저장",
      "송장을 저장하지 못했습니다. 잠시 후 다시 시도해 주십시오",
    );
  };

  const deliver = async () => {
    const ids = items.filter((x) => picked.has(x.orderId)).map((x) => x.orderId);
    if (ids.length === 0) return;
    if (!(await confirm({ title: `${ids.length}건을 배송 완료로 바꾸시겠습니까?`, body: "선택한 주문을 배송 완료로 바꿉니다. 구매자에게 알림이 가고 리뷰 작성이 열립니다.", confirmLabel: "배송 완료로 바꾸기" }))) return;
    await send("/api/seller/shipments/deliver", ids, (chunk) => ({ orderIds: chunk }), (x) => x, "배송 완료", "배송 완료로 바꾸지 못했습니다. 잠시 후 다시 시도해 주십시오");
  };

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const allPicked = items.length > 0 && items.every((r) => picked.has(r.orderId));
  const selectable = tab !== "delivered";

  return (
    <>
      <Topbar crumb="판매 › 배송" />
      <main className="main">
        <PageHead title="배송" />

        <div className="card">
          <nav className="tabs" aria-label="배송 상태" style={{ padding: "0 16px" }}>
            {TABS.map((t) => (
              <button key={t.key} type="button" className={`tab${tab === t.key ? " on" : ""}`} aria-pressed={tab === t.key} disabled={busy} onClick={() => setTab(t.key)}>
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
                disabled={busy}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {tab === "ready" && (
              <>
                <select className="inp inp-sm" style={{ width: "auto" }} aria-label="택배사 일괄 선택" value={courier} onChange={(e) => {
                    // 일괄 선택을 바꾸면 줄마다 바꾼 택배사도 모두 이 값으로 맞춘다
                    setCourier(e.target.value as Courier);
                    setCourierOf({});
                  }}>
                  {(Object.keys(COURIERS) as Courier[]).map((c) => (
                    <option key={c} value={c}>
                      {COURIERS[c]}
                    </option>
                  ))}
                </select>
                <button className="btn btn-sm" type="button" onClick={() => void ship()} disabled={busy || readyTargets.length === 0}>
                  {busy ? "저장 중" : `송장 저장${readyTargets.length > 0 ? ` (${readyTargets.length})` : ""}`}
                </button>
              </>
            )}
            {tab === "in_transit" && (
              <button className="btn btn-sm" type="button" onClick={() => void deliver()} disabled={busy || picked.size === 0}>
                {busy ? "처리 중" : `배송 완료 처리${picked.size > 0 ? ` (${picked.size})` : ""}`}
              </button>
            )}
          </div>
          {tab === "ready" && missing > 0 && <span className="t-c1 c-alt" style={{ padding: "0 16px 12px", display: "block" }}>송장번호를 적지 않은 {missing}건은 저장하지 않습니다.</span>}

          {state.kind === "loading" && <LoadingRows rows={5} />}
          {state.kind === "error" &&
            (state.status === 403 ? <NoPermission need="주문·배송" /> : <ErrorState title="배송 목록을 불러오지 못했습니다" onRetry={() => void load(tab, q)} />)}
          {state.kind === "ok" &&
            (items.length === 0 ? (
              <div className="st">
                <span className="t">{q ? "조건에 맞는 주문이 없습니다" : tab === "ready" ? "발송할 주문이 없습니다" : tab === "in_transit" ? "배송 중인 주문이 없습니다" : "배송 완료된 주문이 없습니다"}</span>
              </div>
            ) : (
              <>
                <div style={{ overflowX: "auto" }}>
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
                                주문번호 {r.orderNo} · {listDate(r.createdAt)}
                              </span>
                            </div>
                          </td>
                          <td className="ship-rcpt col-text">
                            <Recipient a={r.shippingAddress} />
                          </td>
                          <td>
                            {tab === "ready" ? (
                              <div className="row ship-input" style={{ gap: 6 }}>
                              <select
                                className="inp inp-sm"
                                style={{ width: "auto" }}
                                aria-label={`주문 ${r.orderNo} 택배사`}
                                value={courierOf[r.orderId] ?? courier}
                                onChange={(e) => setCourierOf((c) => ({ ...c, [r.orderId]: e.target.value as Courier }))}
                              >
                                {(Object.keys(COURIERS) as Courier[]).map((c) => (
                                  <option key={c} value={c}>
                                    {COURIERS[c]}
                                  </option>
                                ))}
                              </select>
                              <input
                                className="inp inp-sm"
                                autoCapitalize="characters"
                                aria-label={`주문 ${r.orderNo} 송장번호`}
                                placeholder="송장번호"
                                value={tracking[r.orderId] ?? ""}
                                onChange={(e) => {
                                  const v = e.target.value;
                                  setTracking((t) => ({ ...t, [r.orderId]: v }));
                                  // 송장번호를 적으면 그 주문을 고른 것으로 본다
                                  if (v.trim() && !picked.has(r.orderId)) toggle(r.orderId);
                                }}
                              />
                              </div>
                            ) : r.shipment ? (
                              <div className="col" style={{ gap: 2 }}>
                                <span>{courierName(r.shipment.courier)}</span>
                                <span className="t-c1 c-alt num">{r.shipment.trackingNumber}</span>
                              </div>
                            ) : (
                              "-"
                            )}
                            {errors[r.orderId] && (
                              <span className="err t-c1" role="alert" style={{ display: "block", marginTop: 4 }}>
                                {errors[r.orderId]}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="row" style={{ justifyContent: "space-between", padding: "12px 16px" }}>
                  <span className="t-c1 c-alt">{state.next ? `${items.length}건 넘게` : `${items.length}건`}</span>
                  {state.next && (
                    <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                      {more ? "불러오는 중" : "더 보기"}
                    </button>
                  )}
                </div>
              </>
            ))}
        </div>
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
