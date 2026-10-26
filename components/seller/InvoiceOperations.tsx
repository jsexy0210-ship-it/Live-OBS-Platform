"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ListTable, PageHead } from "../admin-ui";
import { formatDateTime } from "../../lib/client/format";
import { sanitizeNext } from "../../lib/client/navigation";
import { Topbar, useSeller } from "./SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "./States";
import { api } from "./api";
import { openPrintWindow, printLabels, type Label } from "./shipping/printLabels";

export type InvoiceRow = { id: string; courierName: string; trackingNumber: string | null; status: "FAILED" | "ISSUED" | "PRINTED" | "PICKED_UP" | "DELIVERED"; issuing: boolean; failureCode: string | null; pickupDelayed: boolean; lastEvent: { kind: string; at: string; note: string | null } | null; issuedAt: string | null; printedAt: string | null; orderCount: number; nickname: string | null };
export type InvoiceDetail = InvoiceRow & { events: { kind: string; at: string; source: string; note: string | null }[]; recipient: { name: string; phone: string; zipCode: string; address1: string; address2: string | null } | null };
export const INVOICE_EVENT: Record<string, string> = { ISSUED: "발급", PRINTED: "출력", PICKUP_REQUESTED: "집하 요청", PICKED_UP: "집하", IN_TRANSIT: "간선 이동", OUT_FOR_DELIVERY: "배송 출발", DELIVERED: "배송 완료" };
export const INVOICE_SOURCE: Record<string, string> = { SELLER: "파트너스", CARRIER: "택배사", SYSTEM: "시스템" };
export const INVOICE_TAG: Record<InvoiceRow["status"], { label: string; cls: string }> = { FAILED: { label: "발급 실패", cls: "r" }, ISSUED: { label: "발급됨", cls: "y" }, PRINTED: { label: "출력됨", cls: "" }, PICKED_UP: { label: "집하됨", cls: "bl" }, DELIVERED: { label: "배송 완료", cls: "g" } };

// 송장 발급 결과와 출력·재발급·집하 재요청을 실제 업무 상세에서 확인한다.
export function InvoiceOperations({ ids, unprinted = false, single = false, initialFormat, returnTo }: { ids: string[]; unprinted?: boolean; single?: boolean; initialFormat?: string | null; returnTo?: string | null }) {
  const { can, me } = useSeller();
  const allowed = can("ORDER_SHIPPING");
  const canEdit = allowed && !me.readOnly;
  const key = ids.join(",");
  const requestIds = useMemo(() => [...new Set(key.split(",").filter(Boolean).map((id) => id.toLowerCase()))], [key]);
  const valid = unprinted || (requestIds.length > 0 && requestIds.length <= 100 && requestIds.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)));
  const safeReturnTo = sanitizeNext(returnTo, ["/seller/shipping/tracking"]);
  const listHref = safeReturnTo?.split("?")[0] === "/seller/shipping/tracking" ? safeReturnTo : "/seller/shipping/tracking";
  const generation = useRef(0);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: InvoiceDetail[]; missing: number; unprinted: number }>({ kind: "loading" });
  const [format, setFormat] = useState<"LABEL_100X150" | "A4_2UP">(initialFormat === "A4_2UP" ? "A4_2UP" : "LABEL_100X150");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!allowed || !valid) return;
    if (unprinted) {
      // 출력 대상은 기존 POST의 '현재 미출력 최대 100개' 계약이다. 첫 페이지를 전체로 간주하지 않는다.
      const r = await api<{ unprinted: number }>("/api/seller/invoices");
      if (request !== generation.current) return;
      return setState(r.ok ? { kind: "ok", items: [], missing: 0, unprinted: r.data.unprinted } : { kind: "error", status: r.status });
    }
    const responses = await Promise.all(requestIds.map((id) => api<{ invoice: InvoiceDetail }>(`/api/seller/invoices/${id}`)));
    if (request !== generation.current) return;
    const failed = responses.find((r) => !r.ok && (single || r.status !== 404));
    if (failed && !failed.ok) return setState({ kind: "error", status: failed.status });
    setState({ kind: "ok", items: responses.flatMap((r) => r.ok ? [r.data.invoice] : []), missing: responses.filter((r) => !r.ok && r.status === 404).length, unprinted: 0 });
  }, [allowed, valid, unprinted, requestIds, single]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const items = state.kind === "ok" ? state.items : [];
  const detail = single ? items[0] : null;
  const print = async () => {
    if (!canEdit || busy || state.kind !== "ok" || (unprinted ? state.unprinted === 0 : !items.some((item) => item.trackingNumber))) return;
    // 기존과 같이 비동기 요청 전에 인쇄 창을 열어 팝업 차단을 피한다.
    const win = openPrintWindow();
    if (!win) return setToast({ text: "인쇄 창을 열지 못했습니다. 팝업 차단을 풀어 주십시오", neg: true });
    setBusy(true);
    const r = await api<{ labels: Label[]; printed: number }>("/api/seller/invoices/print", { method: "POST", body: { format, ...(!unprinted ? { invoiceIds: items.map((item) => item.id) } : {}) } });
    setBusy(false);
    if (!r.ok || r.data.labels.length === 0) {
      win.close();
      return setToast({ text: !r.ok ? (r.message ?? "출력하지 못했습니다. 잠시 후 다시 시도해 주십시오") : "출력할 송장이 없습니다", neg: true });
    }
    printLabels(win, r.data.labels, format);
    setToast({ text: `송장 ${r.data.labels.length}개를 출력했습니다` });
    void load();
  };
  const retry = async () => {
    if (!canEdit || busy || state.kind !== "ok" || !detail || detail.status !== "FAILED") return;
    setBusy(true);
    const r = await api<{ result: { ok: boolean } }>(`/api/seller/invoices/${detail.id}/retry`, { method: "POST" });
    setBusy(false);
    const ok = r.ok && r.data.result.ok;
    setToast(ok ? { text: "송장을 다시 발급했습니다" } : { text: (!r.ok && r.message) || "다시 발급하지 못했습니다. 잠시 후 다시 시도해 주십시오", neg: true });
    void load();
  };
  const pickup = async () => {
    if (!canEdit || busy || state.kind !== "ok" || !detail || !detail.pickupDelayed) return;
    setBusy(true);
    const r = await api<{ ok?: boolean }>(`/api/seller/invoices/${detail.id}/pickup-request`, { method: "POST" });
    setBusy(false);
    setToast(r.ok ? { text: "집하 요청을 다시 보냈습니다" } : { text: r.message ?? "집하 요청을 보내지 못했습니다", neg: true });
    if (r.ok) void load();
  };
  return <><Topbar crumb="주문 › 배송 · 송장 › 송장 업무 상세" /><main className="main">
    <PageHead title={single ? "송장 업무 상세" : "송장 출력 상세"} back={listHref} />
    {!allowed ? <NoPermission need="주문·배송" /> : !valid ? <div className="card pad">작업할 송장을 목록에서 다시 선택해 주십시오.</div> : state.kind === "loading" ? <div className="card"><LoadingRows rows={3} /></div> : state.kind === "error" ? state.status === 403 ? <NoPermission need="주문·배송" /> : <div className="card"><ErrorState title="송장을 불러오지 못했습니다" onRetry={() => void load()} /></div> : <section className="col" style={{ gap: 16 }} aria-label="송장 업무 상세">
      {unprinted ? <p>출력 안 한 송장 {state.unprinted}개 · 현재 미출력 송장을 한 번에 최대 100개 출력합니다.</p> : <>
        {state.missing > 0 && <p role="status">찾을 수 없는 송장 {state.missing}개 · 남은 송장 {items.length}개</p>}
        <ListTable><table className="tbl"><thead><tr><th>받는 분</th><th>택배사 · 송장번호</th><th>상태</th></tr></thead><tbody>{items.map((item) => <tr key={item.id}><td>{item.nickname ?? "—"}</td><td>{item.courierName} {item.trackingNumber ?? "—"}</td><td>{item.issuing ? "발급 중" : INVOICE_TAG[item.status].label}</td></tr>)}</tbody></table></ListTable>
      </>}
      {detail?.recipient && <p>{detail.recipient.name} · {detail.recipient.phone}<br />({detail.recipient.zipCode}) {detail.recipient.address1} {detail.recipient.address2}</p>}
      {detail && <ListTable><table className="tbl"><thead><tr><th>시각</th><th>상태</th><th>처리</th><th>비고</th></tr></thead><tbody>{detail.events.map((event, index) => <tr key={index}><td>{formatDateTime(event.at)}</td><td>{INVOICE_EVENT[event.kind] ?? event.kind}</td><td>{event.source === "CARRIER" ? detail.courierName : (INVOICE_SOURCE[event.source] ?? event.source)}</td><td>{event.note ?? ""}</td></tr>)}</tbody></table></ListTable>}
      {canEdit && <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <select className="inp" style={{ width: "auto" }} aria-label="출력 방식" disabled={busy} value={format} onChange={(e) => setFormat(e.target.value as typeof format)}><option value="LABEL_100X150">라벨 프린터</option><option value="A4_2UP">A4 2매</option></select>
        <button className="btn" type="button" disabled={busy || (unprinted ? state.unprinted === 0 : !items.some((item) => item.trackingNumber))} onClick={() => void print()}>{busy ? "처리 중…" : "송장 출력"}</button>
        {detail?.status === "FAILED" && <button className="btn btn-out" type="button" disabled={busy} onClick={() => void retry()}>다시 발급</button>}
        {detail?.pickupDelayed && <button className="btn btn-out" type="button" disabled={busy} onClick={() => void pickup()}>집하 요청 다시 보내기</button>}
      </div>}
    </section>}
    {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
  </main></>;
}
