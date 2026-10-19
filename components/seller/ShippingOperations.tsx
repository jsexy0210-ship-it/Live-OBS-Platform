"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormRow, FormSection, PageHead, useConfirm } from "../admin-ui";
import { useUnsavedGuard } from "../../lib/client/navigation";
import { COURIERS, type Courier } from "../../lib/server/orders/shipping";
import { Topbar, useSeller } from "./SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "./States";
import { api, failMessage } from "./api";
import { type OrderDetail, phoneText } from "./orders";
import { sendInBatches } from "./shipping/sendInBatches";

type Result = { orderId: string; ok: boolean; error?: string; message?: string };
const FAIL: Record<string, string> = {
  not_shippable: "지금은 발송할 수 없는 주문입니다",
  invalid_shipment: "송장번호를 확인해 주십시오",
  not_deliverable: "배송 완료로 바꿀 수 없는 주문입니다",
  not_found: "주문을 찾을 수 없습니다",
};

// 목록은 읽기와 선택만 담당한다. 기존 주문별 부분 처리·택배사/송장 입력은 실제 상세에서 실행한다.
export function ShippingOperations({ ids, action, single = false }: { ids: string[]; action?: "ship" | "deliver"; single?: boolean }) {
  const { can, me } = useSeller();
  const { confirm } = useConfirm();
  const key = ids.join(",");
  const requestIds = useMemo(() => [...new Set(key.split(",").map((id) => id.toLowerCase()))], [key]);
  const valid = requestIds.length > 0 && requestIds.length <= 100 && requestIds.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  const allowed = can("ORDER_SHIPPING");
  const canEdit = allowed && !me.readOnly;
  const generation = useRef(0);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; items: OrderDetail[]; missing: number }>({ kind: "loading" });
  const [courier, setCourier] = useState<Courier>("CJ");
  const [courierOf, setCourierOf] = useState<Record<string, Courier>>({});
  const [tracking, setTracking] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  useUnsavedGuard(Object.values(tracking).some((value) => value.trim() !== ""));
  const load = useCallback(async () => {
    const request = ++generation.current;
    if (!allowed || !valid) return;
    const responses = await Promise.all(requestIds.map((id) => api<OrderDetail>(`/api/seller/orders/${id}`)));
    if (request !== generation.current) return;
    const failed = responses.find((r) => !r.ok && (single || r.status !== 404));
    if (failed && !failed.ok) return setState({ kind: "error", status: failed.status });
    setState({ kind: "ok", items: responses.flatMap((r) => r.ok ? [r.data] : []), missing: responses.filter((r) => !r.ok && r.status === 404).length });
  }, [allowed, valid, requestIds, single]);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  const items = state.kind === "ok" ? state.items : [];
  const mode = action ?? (items[0]?.shipment?.status === "IN_TRANSIT" ? "deliver" : "ship");
  const targets = items.filter((order) => order.status === "PAID" && (mode === "deliver" ? order.shipment?.status === "IN_TRANSIT" : !order.shipment || order.shipment.status === "READY"));
  const readyTargets = targets.filter((order) => (tracking[order.id] ?? "").trim() !== "");
  const missing = targets.length - readyTargets.length;
  const applyResults = async (results: Result[], verb: string) => {
    const okIds = results.filter((r) => r.ok).map((r) => r.orderId);
    const failed = results.filter((r) => !r.ok);
    setErrors(Object.fromEntries(failed.map((r) => [r.orderId, r.message ?? FAIL[r.error ?? ""] ?? "처리하지 못했습니다"])));
    setTracking((t) => Object.fromEntries(Object.entries(t).filter(([id]) => !okIds.includes(id))));
    setState((s) => s.kind === "ok" ? { ...s, items: s.items.filter((order) => !okIds.includes(order.id)) } : s);
    const parts = [okIds.length > 0 ? `${okIds.length}건 ${verb}` : null, failed.length > 0 ? `${failed.length}건은 처리하지 못했습니다. 빨간 글씨를 확인해 주십시오` : null].filter(Boolean).join(" · ");
    setToast({ text: parts, neg: failed.length > 0 && okIds.length === 0 });
  };
  const send = async <T,>(path: string, list: T[], body: (chunk: T[]) => unknown, idOf: (x: T) => string, verb: string, failText: string) => {
    if (!canEdit || busy || state.kind !== "ok" || list.length === 0) return;
    setBusy(true);
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
    if (!canEdit || busy || readyTargets.length === 0) return;
    if (!(await confirm({ title: `송장 ${readyTargets.length}건을 저장하시겠습니까?`, body: "택배사·송장번호를 저장하고 해당 주문을 「배송 중」으로 바꿉니다. 구매자에게 알림이 갑니다.", confirmLabel: "송장 저장" }))) return;
    await send("/api/seller/shipments", readyTargets, (chunk) => ({ items: chunk.map((x) => ({ orderId: x.id, courier: courierOf[x.id] ?? courier, trackingNumber: tracking[x.id].trim() })) }), (x) => x.id, "송장 저장", "송장을 저장하지 못했습니다. 잠시 후 다시 시도해 주십시오");
  };
  const deliver = async () => {
    const ids = targets.map((order) => order.id);
    if (!canEdit || busy || ids.length === 0) return;
    if (!(await confirm({ title: `${ids.length}건을 배송 완료로 바꾸시겠습니까?`, body: "선택한 주문을 배송 완료로 바꿉니다. 구매자에게 알림이 가고 리뷰 작성이 열립니다.", confirmLabel: "배송 완료로 바꾸기" }))) return;
    await send("/api/seller/shipments/deliver", ids, (chunk) => ({ orderIds: chunk }), (x) => x, "배송 완료", "배송 완료로 바꾸지 못했습니다. 잠시 후 다시 시도해 주십시오");
  };
  return <><Topbar crumb="판매 › 배송 › 배송 처리 상세" /><main className="main">
    <PageHead title="배송 처리 상세" back="/seller/shipping" />
    {!allowed ? <NoPermission need="주문·배송" /> : !valid ? <div className="card pad">작업할 주문을 목록에서 다시 선택해 주십시오.</div> : state.kind === "loading" ? <div className="card"><LoadingRows rows={4} /></div> : state.kind === "error" ? state.status === 403 ? <NoPermission need="주문·배송" /> : <div className="card"><ErrorState title="선택한 주문을 불러오지 못했습니다" onRetry={() => void load()} /></div> : <section className="col" style={{ gap: 16 }} aria-label="배송 처리 상세">
      <p>선택한 {items.length}건만 처리합니다. 이미 처리됐거나 바꿀 수 없는 주문은 제외합니다.</p>
      {state.missing > 0 && <p role="status">찾을 수 없는 주문 {state.missing}건 · 남은 주문 {items.length}건</p>}
      {canEdit && mode === "ship" && <label className="row" style={{ gap: 8 }}>택배사 일괄 선택<select className="inp" style={{ width: "auto" }} aria-label="택배사 일괄 선택" disabled={busy} value={courier} onChange={(e) => { setCourier(e.target.value as Courier); setCourierOf({}); }}>{(Object.keys(COURIERS) as Courier[]).map((code) => <option key={code} value={code}>{COURIERS[code]}</option>)}</select></label>}
      {items.map((order) => <FormSection key={order.id} title={`주문 ${order.orderNo}`}>
        <FormRow label="주문"><Link href={`/seller/orders/${order.id}`}>{order.orderNoLabel} · {order.buyer.broadcastNickname}</Link></FormRow>
        <FormRow label="받는 분">{order.shippingAddress?.recipientName ?? "—"}{order.shippingAddress?.phone ? ` · ${phoneText(order.shippingAddress.phone)}` : ""}<br />{order.shippingAddress?.zipCode ? `(${order.shippingAddress.zipCode}) ` : ""}{order.shippingAddress?.address1} {order.shippingAddress?.address2}{order.shippingAddress?.isRemote ? " · 도서산간" : ""}</FormRow>
        {order.shipment && <FormRow label="택배사 · 송장번호">{COURIERS[order.shipment.courier as Courier] ?? order.shipment.courier} · {order.shipment.trackingNumber}</FormRow>}
        {canEdit && mode === "ship" && targets.some((target) => target.id === order.id) && <>
          <FormRow label="택배사"><select className="inp" style={{ width: "auto" }} aria-label={`주문 ${order.orderNo} 택배사`} disabled={busy} value={courierOf[order.id] ?? courier} onChange={(e) => setCourierOf((values) => ({ ...values, [order.id]: e.target.value as Courier }))}>{(Object.keys(COURIERS) as Courier[]).map((code) => <option key={code} value={code}>{COURIERS[code]}</option>)}</select></FormRow>
          <FormRow label="송장번호"><input className="inp" autoCapitalize="characters" aria-label={`주문 ${order.orderNo} 송장번호`} placeholder="송장번호" disabled={busy} value={tracking[order.id] ?? ""} onChange={(e) => setTracking((values) => ({ ...values, [order.id]: e.target.value }))} /></FormRow>
        </>}
        {errors[order.id] && <FormRow label="처리 결과"><span className="err" role="alert">{errors[order.id]}</span></FormRow>}
      </FormSection>)}
      {canEdit && mode === "ship" && missing > 0 && <p className="help">송장번호를 적지 않은 {missing}건은 저장하지 않습니다.</p>}
      {canEdit && <button className="btn" type="button" disabled={busy || (mode === "ship" ? readyTargets.length === 0 : targets.length === 0)} onClick={() => void (mode === "ship" ? ship() : deliver())}>{busy ? "처리 중" : mode === "ship" ? `송장 저장${readyTargets.length ? ` (${readyTargets.length})` : ""}` : `배송 완료 처리${targets.length ? ` (${targets.length})` : ""}`}</button>}
    </section>}
    {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
  </main></>;
}
