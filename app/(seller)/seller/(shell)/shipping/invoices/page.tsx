"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHead, useConfirm, ListTable, ListHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { itemSummaryText, phoneText } from "../../../../../../components/seller/orders";
import { InvoiceSteps } from "../../../../../../components/seller/shipping/InvoiceSteps";
import { useUrlState } from "../../../../../../lib/client/navigation";
import "../../../../../../styles/seller-orders.css";
import "../../../../../../styles/seller-invoices.css";

// SA-027 송장 발급(통합 「배송 · 송장」 탭). 2단계 합배송 · 주소 확인 → 3단계 발급. 배송 접수 업체가 정해지기 전이라 서버는 모의 발급이다.
// 주문은 주소 ?ids=(쉼표)로 받고, 없으면 발송 대기 주문 전체를 고른 것으로 시작한다.

type Plan = {
  rows: {
    orderId: string;
    orderNoLabel: string;
    nickname: string | null;
    itemSummary: { firstProductName: string | null; otherCount: number };
    groupNo: number;
    bundleCount: number;
    addressIssue: "zip_missing" | "address_missing" | null;
    isRemote: boolean;
    shippingAddress: { recipientName: string; phone: string; zipCode: string; address1: string; address2: string | null } | null;
  }[];
  rejected: { orderId: string; reason: string }[];
  summary: { invoices: number; orders: number; addressIssues: number; bundles: number };
};
type Row = Plan["rows"][number];
type Issued = {
  courierName: string;
  results: { orderIds: string[]; invoiceId: string | null; ok: boolean; reason?: string }[];
  skipped: { orderIds: string[]; reason: string }[];
  issued: number;
  failed: number;
};
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok" };

const READY_BATCH = 50;
const REASON: Record<string, string> = {
  provider_error: "택배사 응답 오류",
  invalid_transition: "이미 처리된 송장",
  zip_missing: "우편번호 없음",
  address_missing: "주소 없음",
  not_ready: "보낼 수 없는 주문",
  already_invoiced: "이미 송장이 있는 주문",
  not_found: "주문을 찾을 수 없음",
};

export default function InvoiceIssuePage() {
  const { confirm } = useConfirm();
  const { can } = useSeller();
  const canIssue = can("ORDER_SHIPPING");
  const [u] = useUrlState({ ids: "" });
  const [ids, setIds] = useState<string[] | null>(u.ids ? u.ids.split(",").filter(Boolean) : null);
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [plan, setPlan] = useState<Plan | null>(null);
  const [cache, setCache] = useState<Record<string, Row>>({});
  const [picked, setPicked] = useState<Set<string>>(() => new Set(u.ids ? u.ids.split(",").filter(Boolean) : []));
  const [bundle, setBundle] = useState(false);
  const [remoteOnly, setRemoteOnly] = useState(false);
  const [courier, setCourier] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Issued | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  // 주문 주소가 없으면 발송 대기 주문 중 발급할 수 있는 것부터 최대 50건(이미 송장이 있는 주문은 건너뛰며 다음 쪽까지 찾는다)
  useEffect(() => {
    if (ids) return;
    void (async () => {
      const found: string[] = [];
      let cursor: string | null = null;
      for (let pageNo = 0; pageNo < 10 && found.length < READY_BATCH; pageNo++) {
        const r: Awaited<ReturnType<typeof api<{ shipments: { orderId: string }[]; nextCursor: string | null }>>> = await api(`/api/seller/shipments?tab=ready&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
        if (!r.ok) {
          setState({ kind: "error", status: r.status });
          return;
        }
        const pageIds = r.data.shipments.map((x) => x.orderId);
        if (pageIds.length > 0) {
          const pr = await api<Plan>("/api/seller/invoices/plan", { method: "POST", body: { orderIds: pageIds } });
          if (!pr.ok) {
            setState({ kind: "error", status: pr.status });
            return;
          }
          found.push(...pr.data.rows.map((x) => x.orderId));
        }
        cursor = r.data.nextCursor;
        if (!cursor) break;
      }
      const list = found.slice(0, READY_BATCH);
      setIds(list);
      setPicked(new Set(list));
    })();
  }, [ids]);
  useEffect(() => {
    void (async () => {
      const r = await api<{ policy: { defaultCourier: string | null }; couriers: Record<string, string> }>("/api/seller/shipping-policy");
      if (r.ok && r.data.policy.defaultCourier) setCourier(r.data.couriers[r.data.policy.defaultCourier] ?? r.data.policy.defaultCourier);
    })();
  }, []);

  const pickedIds = useMemo(() => (ids ?? []).filter((id) => picked.has(id)), [ids, picked]);
  const load = useCallback(async (orderIds: string[], bundled: boolean, first = false) => {
    if (orderIds.length === 0) {
      setPlan({ rows: [], rejected: [], summary: { invoices: 0, orders: 0, addressIssues: 0, bundles: 0 } });
      setState({ kind: "ok" });
      return;
    }
    const r = await api<Plan>("/api/seller/invoices/plan", { method: "POST", body: { orderIds, bundle: bundled } });
    if (r.ok) {
      setPlan(r.data);
      setCache((c) => ({ ...c, ...Object.fromEntries(r.data.rows.map((x) => [x.orderId, x])) }));
      setState({ kind: "ok" });
    } else if (first) setState({ kind: "error", status: r.status });
    else setToast({ text: "주문을 확인하지 못했습니다. 잠시 후 다시 시도해 주십시오", neg: true });
  }, []);
  // 처음에는 고른 주문 전체로, 이후에는 체크가 바뀔 때마다 고른 주문만 다시 묶는다
  const [first, setFirst] = useState(true);
  useEffect(() => {
    if (!ids) return;
    if (first) {
      setFirst(false);
      void load(ids, bundle, true);
    }
  }, [ids, first, bundle, load]);
  useEffect(() => {
    if (!ids || first) return;
    void load(pickedIds, bundle);
  }, [pickedIds.join(","), bundle]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = useMemo(() => {
    const byId = new Map((plan?.rows ?? []).map((r) => [r.orderId, r]));
    const list = (ids ?? []).map((id) => byId.get(id) ?? cache[id]).filter((r): r is Row => !!r);
    return remoteOnly ? list.filter((r) => r.isRemote) : list;
  }, [plan, cache, ids, remoteOnly]);
  const issueRows = (plan?.rows ?? []).filter((r) => r.addressIssue);
  const bundleName = (plan?.rows ?? []).find((r) => r.bundleCount > 1)?.nickname;
  const summary = plan?.summary;

  const toggleBundle = async () => {
    if (!bundle && !(await confirm({ title: "같은 받는 분의 주문을 한 상자로 묶으시겠습니까?", body: "받는 분 · 주소 · 연락처가 같은 주문을 송장 하나로 묶습니다.", confirmLabel: "묶기" }))) return;
    setBundle(!bundle);
  };

  const issue = async () => {
    setBusy(true);
    const r = await api<Issued>("/api/seller/invoices", { method: "POST", body: { orderIds: pickedIds, bundle } });
    setBusy(false);
    if (!r.ok) {
      setToast({ text: r.message ?? "송장을 발급하지 못했습니다. 잠시 후 다시 시도해 주십시오", neg: true });
      return;
    }
    setDone(r.data);
    const okIds = new Set(r.data.results.filter((x) => x.ok).flatMap((x) => x.orderIds));
    setIds((cur) => (cur ?? []).filter((id) => !okIds.has(id)));
    setPicked((p) => new Set([...p].filter((id) => !okIds.has(id))));
    if (r.data.issued > 0) setToast({ text: `송장 ${r.data.issued}개를 발급했습니다 · 출력 전까지 집하되지 않습니다` });
  };

  const retry = async () => {
    if (!done) return;
    setBusy(true);
    const failedIds = done.results.filter((x) => !x.ok && x.invoiceId);
    const fixedOk = new Set<string>();
    for (const f of failedIds) {
      const r = await api<{ result: { ok: boolean } }>(`/api/seller/invoices/${f.invoiceId}/retry`, { method: "POST" });
      if (r.ok && r.data.result.ok) fixedOk.add(f.invoiceId as string);
    }
    const fixed = fixedOk.size;
    setBusy(false);
    setDone((d) => (d ? { ...d, issued: d.issued + fixed, failed: d.failed - fixed, results: d.results.map((x) => (x.invoiceId && fixedOk.has(x.invoiceId) ? { ...x, ok: true } : x)) } : d));
    const okOrders = new Set(failedIds.filter((f) => fixedOk.has(f.invoiceId as string)).flatMap((f) => f.orderIds));
    setIds((cur) => (cur ?? []).filter((id) => !okOrders.has(id)));
    setToast(fixed > 0 ? { text: `${fixed}개를 다시 발급했습니다` } : { text: "다시 발급하지 못했습니다. 잠시 후 다시 시도해 주십시오", neg: true });
  };

  const allPicked = (ids ?? []).length > 0 && (ids ?? []).every((id) => picked.has(id));
  const failedRows = done?.results.filter((x) => !x.ok) ?? [];

  return (
    <>
      <Topbar crumb="주문 › 배송 · 송장 › 송장 발급" />
      <main className="main">
        <PageHead description="발송할 주문과 주소를 확인하고 송장을 발급합니다." title="송장 발급" />
        <InvoiceSteps now={done && done.issued > 0 ? 4 : 2} />

        {state.kind === "loading" && <LoadingRows rows={5} />}
        {state.kind === "error" && (state.status === 403 ? <NoPermission need="주문·배송" /> : <ErrorState title="송장 발급 대상을 불러오지 못했습니다" onRetry={() => window.location.reload()} />)}
        {state.kind === "ok" && (
          <>
            <div className="au-list-section">
              <ListHead total={rows.length} loaded actions={<><span className="t-c1">고른 주문 {pickedIds.length}건</span>
<span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {canIssue && (
                    <button className="btn btn-sm btn-out" type="button" disabled={busy} onClick={() => void toggleBundle()}>
                      {bundle ? "묶기 해제" : "같은 받는 분 묶기"}
                    </button>
                  )}
                  <button className="btn btn-sm btn-out" type="button" aria-pressed={remoteOnly} onClick={() => setRemoteOnly(!remoteOnly)}>
                    도서산간만
                  </button>
                </span></>} />
              {rows.length === 0 ? (
                <div className="st">
                  <span className="t">{done && done.issued > 0 ? "발급할 주문이 남아 있지 않습니다" : "발급할 주문이 없습니다"}</span>
                </div>
              ) : (
                <>

<ListTable>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 36 }}>
                          <input className="cbx" type="checkbox" aria-label="모두 선택" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(ids ?? []))} />
                        </th>
                        <th style={{ width: "42%" }}>주문자 · 상품</th>
                        <th>받는 분 · 주소</th>
                        <th style={{ width: 110 }}>표시</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const a = r.shippingAddress;
                        const on = picked.has(r.orderId);
                        return (
                          <tr key={r.orderId}>
                            <td>
                              <input
                                className="cbx"
                                type="checkbox"
                                aria-label={`주문 ${r.orderNoLabel} 선택`}
                                checked={on}
                                onChange={() => setPicked((p) => { const n = new Set(p); if (n.has(r.orderId)) n.delete(r.orderId); else n.add(r.orderId); return n; })}
                              />
                            </td>
                            <td className="col-product">
                              {r.nickname ?? "—"}
                              <span className="t-c1 c-alt" style={{ display: "block" }}>{itemSummaryText(r.itemSummary)}</span>
                            </td>
                            <td className="col-address">
                              {a ? (
                                <>
                                  {a.recipientName} · {phoneText(a.phone)}
                                  <span className="t-c1 c-alt" style={{ display: "block" }}>
                                    {a.address1}
                                    {a.address2 ? ` ${a.address2}` : ""}
                                    {r.addressIssue === "zip_missing" ? " (우편번호 없음)" : r.addressIssue === "address_missing" ? " (주소 없음)" : ""}
                                  </span>
                                </>
                              ) : (
                                <span className="t-c1 c-alt">개인정보 보기 권한이 없어 가려집니다</span>
                              )}
                            </td>
                            <td>
                              {r.addressIssue ? <span className="inv-tag r">주소 확인</span> : on && r.bundleCount > 1 ? <span className="inv-tag bl">합배송 {r.groupNo}</span> : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ListTable>
</>
              )}
            </div>

            <h2 className="t-h3" style={{ margin: "16px 0 8px" }}>합배송 · 주소 확인</h2>
            <table className="inv-sum">
              <tbody>
                <tr>
                  <th>묶음</th>
                  <td>{summary && summary.bundles > 0 ? `${bundleName ?? "같은 받는 분"} 주문 → 상자 ${summary.bundles}개 묶음` : "묶은 주문 없음"}</td>
                  <th>발급할 송장</th>
                  <td>{summary ? `${summary.invoices}개 (${summary.orders}건)` : "—"}</td>
                </tr>
                <tr>
                  <th>택배사</th>
                  <td>
                    {courier ?? (
                      <>
                        기본 택배사를 정해 주십시오{" "}
                        <Link className="btn btn-sm btn-out" href="/seller/settings/shipping">배송 설정</Link>
                      </>
                    )}
                  </td>
                  <th>주소 확인 필요</th>
                  <td>
                    {issueRows.length > 0 ? (
                      <>
                        {issueRows.length}건 · {issueRows[0].nickname ?? ""}
                        {issueRows[0].addressIssue === "zip_missing" ? " (우편번호 없음)" : " (주소 없음)"}{" "}
                        <Link className="btn btn-sm btn-out" href={`/seller/orders/${issueRows[0].orderId}`}>주소 확인</Link>
                      </>
                    ) : (
                      "없음"
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
            <div className="msg msg-info" role="status" style={{ marginTop: 12 }}>
              <span>주소를 확인하지 않은 주문은 발급에서 빠집니다 · 배송 접수 업체는 아직 정해지지 않아 지금은 모의 발급으로 흐름만 확인합니다.</span>
            </div>
            {failedRows.length > 0 && (
              <div className="msg msg-neg" role="alert" style={{ marginTop: 12 }}>
                <span>
                  <b>{failedRows.length}건 발급 실패 · {REASON[failedRows[0].reason ?? ""] ?? "처리하지 못했습니다"}.</b> 나머지 {done?.issued ?? 0}개는 발급되었습니다 · 실패 건만 다시 시도할 수 있습니다.
                </span>
                {canIssue && (
                  <button className="btn btn-sm" type="button" disabled={busy} onClick={() => void retry()}>
                    실패 건 다시 발급
                  </button>
                )}
              </div>
            )}
            {done && done.issued > 0 && failedRows.length === 0 && (
              <div className="msg msg-info" role="status" style={{ marginTop: 12 }}>
                <span>송장 {done.issued}개를 발급했습니다 · 출력 전까지 집하되지 않습니다</span>
                <Link className="btn btn-sm" href="/seller/shipping/tracking">출력하기</Link>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              {canIssue && (
                <button className="btn" type="button" disabled={busy || !courier || !summary || summary.invoices === 0} onClick={() => void issue()}>
                  {busy ? "발급 중…" : `송장 ${summary?.invoices ?? 0}개 발급`}
                </button>
              )}
              <Link className="btn btn-out" href="/seller/shipping">배송 목록</Link>
            </div>
          </>
        )}
        {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
