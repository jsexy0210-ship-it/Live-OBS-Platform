"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ListHead, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";
import { PAYMENT_KIND } from "../../../_components/payments";
import { day, dayTime, won } from "../../../_components/partners";
import { REFUND_SOURCE, REFUND_STATUS, REFUND_TABS, refundReason, type Refund, type RefundCounts, type RefundStatus } from "../../../_components/refunds";

// MA-026 환불 요청 목록(GET /api/admin/subscription-refunds, 모든 마스터 역할, 조회만). 상태 탭의 숫자는 서버의 상태별 전체 수.
// 승인·거절은 상세(MA-027)에서 한다. 요청 최신 순 50건씩 이어서 불러온다.
type Page = { items: Refund[]; counts: RefundCounts; nextCursor: string | null };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; items: Refund[]; counts: RefundCounts; next: string | null };

export default function RefundsPage() {
  const [tab, setTab] = useState<RefundStatus | "">("REQUESTED");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reqId = useRef(0);
  const qs = (status: string, cursor?: string) => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (cursor) p.set("cursor", cursor);
    return p.toString();
  };
  const load = useCallback(async (status: string) => {
    const id = ++reqId.current;
    setMore(false);
    setState({ kind: "loading" });
    const r = await adminApi<Page>(`/api/admin/subscription-refunds?${qs(status)}`);
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", items: r.data.items, counts: r.data.counts, next: r.data.nextCursor } : { kind: "error" });
  }, []);
  useEffect(() => void load(tab), [tab, load]);

  const loadMore = async () => {
    if (state.kind !== "ok" || !state.next) return;
    setMore(true);
    const id = reqId.current;
    const r = await adminApi<Page>(`/api/admin/subscription-refunds?${qs(tab, state.next)}`);
    if (id !== reqId.current) return;
    setMore(false);
    if (r.ok) setState({ ...state, items: [...state.items, ...r.data.items], next: r.data.nextCursor });
    else setToast("더 불러오지 못했습니다. 다시 눌러 주십시오.");
  };

  const counts = state.kind === "ok" ? state.counts : null;
  const total = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : null;
  const items = state.kind === "ok" ? state.items : [];

  return (
    <>
      <AdminTopbar crumb="구독·요금 › 환불 요청" />
      <main className="main">
        <PageHead title="환불 요청" />
        <div className="col" style={{ gap: 20 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }} role="group" aria-label="상태">
            {REFUND_TABS.map((t) => (
              <button key={t || "all"} type="button" className={`btn btn-sm ${tab === t ? "" : "btn-out"}`} aria-pressed={tab === t} onClick={() => setTab(t)}>
                {t === "" ? "전체" : REFUND_STATUS[t].label}
                {counts && ` ${t === "" ? total : counts[t]}`}
              </button>
            ))}
          </div>
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" && <ErrorState title="환불 요청을 불러오지 못했습니다." onRetry={() => void load(tab)} />}
            {state.kind === "ok" &&
              (items.length === 0 ? (
                <div className="st">
                  <span className="t">{tab === "REQUESTED" ? "대기 중인 환불 요청이 없습니다." : "환불 요청이 없습니다."}</span>
                </div>
              ) : (
                <>
                  <ListHead total={items.length} loaded={state.next !== null} />
                  <div style={{ overflowX: "auto" }}>
                    <table className="tbl" style={{ whiteSpace: "nowrap" }}>
                      <thead>
                        <tr>
                          <th>요청</th>
                          <th>파트너스</th>
                          <th>청구</th>
                          <th>요청 금액</th>
                          <th>사유</th>
                          <th>출처</th>
                          <th>상태</th>
                          <th>관리</th>
                        </tr>
                      </thead>
                      <tbody>
                        {items.map((r) => (
                          <tr key={r.id} data-testid="refund-row">
                            <td>{dayTime(r.createdAt)}</td>
                            <td>
                              <b>{r.shopName}</b>
                            </td>
                            <td>
                              {PAYMENT_KIND[r.payment.kind]} · {day(r.payment.periodStart)} ~ {day(r.payment.periodEnd)}
                            </td>
                            <td>{won(r.amount)}</td>
                            <td className="col-text">{refundReason(r.reason)}</td>
                            <td>{REFUND_SOURCE[r.source]}</td>
                            <td>
                              <span className={`bdg ${REFUND_STATUS[r.status].cls}`}>{REFUND_STATUS[r.status].label}</span>
                            </td>
                            <td>
                              <Link className="btn btn-sm btn-out" href={`/admin/billing/refunds/${r.id}`}>
                                {r.status === "REQUESTED" || r.status === "FAILED" || r.status === "PROCESSING" ? "처리" : "보기"}
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {state.next && (
                    <div className="row" style={{ justifyContent: "center", padding: "12px 16px" }}>
                      <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                        {more ? "불러오는 중" : "더 보기"}
                      </button>
                    </div>
                  )}
                </>
              ))}
          </div>
        </div>
      </main>
      {toast && <Toast text={toast} neg onDone={() => setToast(null)} />}
    </>
  );
}
